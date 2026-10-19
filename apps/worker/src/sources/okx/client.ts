import { z } from "zod";
import type { OkxApiHost } from "../../platform/okx-egress";
import type { ExchangeBalance } from "../exchange-account";
import type { RequestBudget } from "../onchain-wallet";

/**
 * OKX v5 REST API。所有請求經 `OkxEgress` Durable Object 從亞太機房送出；
 * 帳戶端點以 API key、secret 與 passphrase 簽章。
 */

const REQUEST_TIMEOUT_MS = 15_000;
/** 公開行情依 IP 限流，Workers 共用出口 IP，常需等待後重試。 */
const PUBLIC_RATE_LIMIT_RETRIES = 2;
const PUBLIC_RATE_LIMIT_WAIT_MS = 1_500;

/** API key 不存在於這個站；key 只能在建立它的地區站使用。 */
export const OKX_KEY_NOT_FOUND = "50119";
/** API key、簽章、passphrase、IP 白名單或權限錯誤，需要使用者處理。 */
const AUTH_ERROR_CODES = new Set([
  "50100",
  "50105",
  "50110",
  "50111",
  "50113",
  "50114",
  "50120",
]);
/** 限流、時間誤差、系統忙碌；下次同步通常可成功。 */
const RETRYABLE_ERROR_CODES = new Set(["50001", "50011", "50013", "50102"]);

export class OkxApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OkxApiError";
  }
}

export class OkxAuthError extends OkxApiError {
  constructor(code: string | null) {
    super(
      "OKX API key 無效、passphrase 錯誤或缺少讀取權限，請在資料來源設定重新填寫。",
      code,
    );
    this.name = "OkxAuthError";
  }
}

export type OkxCredentials = {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
};

export type OkxClientOptions = {
  fetcher: typeof fetch;
  host: OkxApiHost;
  credentials: OkxCredentials;
  budget: RequestBudget;
  signal?: AbortSignal;
};

/** OKX 的數字欄位為字串，未適用時為空字串。 */
const decimalSchema = z
  .string()
  .regex(/^(\d+(\.\d+)?)?$/)
  .transform((value) => (value === "" ? 0 : Number(value)));

const envelopeSchema = z.object({
  code: z.string(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
});

async function sign(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function request(
  path: string,
  params: Record<string, string | number | undefined>,
  options: OkxClientOptions,
  signed: boolean,
): Promise<unknown> {
  if (!(await options.budget.take())) {
    throw new OkxApiError("OKX 查詢次數超過單次同步上限。", null, true);
  }
  const query = new URLSearchParams(
    Object.entries(params)
      .filter(
        (entry): entry is [string, string | number] => entry[1] !== undefined,
      )
      .map(([key, value]) => [key, String(value)]),
  );
  const requestPath = `${path}${query.size > 0 ? `?${query}` : ""}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (signed) {
    const timestamp = new Date().toISOString();
    headers["OK-ACCESS-KEY"] = options.credentials.apiKey;
    headers["OK-ACCESS-SIGN"] = await sign(
      options.credentials.apiSecret,
      `${timestamp}GET${requestPath}`,
    );
    headers["OK-ACCESS-TIMESTAMP"] = timestamp;
    headers["OK-ACCESS-PASSPHRASE"] = options.credentials.passphrase;
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await options.fetcher(`https://${options.host}${requestPath}`, {
      method: "GET",
      headers,
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new OkxApiError("OKX 暫時無法連線，請稍後再試。", null, true);
  }

  const envelope = envelopeSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  if (response.ok && envelope.success && envelope.data.code === "0") {
    return envelope.data.data;
  }
  const code = envelope.success ? envelope.data.code : null;
  if (code && AUTH_ERROR_CODES.has(code)) throw new OkxAuthError(code);
  if (code === OKX_KEY_NOT_FOUND) {
    throw new OkxApiError("OKX API key 不存在於這個站。", code);
  }
  if (response.status === 429 || (code && RETRYABLE_ERROR_CODES.has(code))) {
    throw new OkxApiError(
      "OKX 查詢過於頻繁或暫時忙碌，請稍後再試。",
      code,
      true,
    );
  }
  // 錯誤訊息只記代碼，避免把回應內容寫入 log 或同步結果。
  throw new OkxApiError(
    `OKX 回應 HTTP ${response.status}${code ? `（${code}）` : ""}，請稍後再試。`,
    code,
    response.status >= 500,
  );
}

function parse<T extends z.ZodType>(
  schema: T,
  payload: unknown,
  label: string,
) {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new OkxApiError(`OKX ${label}回應格式無法辨識。`);
  }
  return parsed.data as z.infer<T>;
}

/** 交易帳戶各幣別權益（含凍結）。 */
export async function fetchTradingBalances(
  options: OkxClientOptions,
): Promise<ExchangeBalance[]> {
  const data = parse(
    z.array(
      z.object({
        details: z.array(z.object({ ccy: z.string(), eq: decimalSchema })),
      }),
    ),
    await request("/api/v5/account/balance", {}, options, true),
    "交易帳戶",
  );
  return data.flatMap(({ details }) =>
    details.map(({ ccy, eq }) => ({ asset: ccy, amount: eq })),
  );
}

/** 資金帳戶（含凍結）。 */
export async function fetchFundingBalances(
  options: OkxClientOptions,
): Promise<ExchangeBalance[]> {
  const data = parse(
    z.array(z.object({ ccy: z.string(), bal: decimalSchema })),
    await request("/api/v5/asset/balances", {}, options, true),
    "資金帳戶",
  );
  return data.map(({ ccy, bal }) => ({ asset: ccy, amount: bal }));
}

/** 簡單賺幣（活期）。 */
export async function fetchSavingsBalances(
  options: OkxClientOptions,
): Promise<ExchangeBalance[]> {
  const data = parse(
    z.array(z.object({ ccy: z.string(), amt: decimalSchema })),
    await request("/api/v5/finance/savings/balance", {}, options, true),
    "簡單賺幣",
  );
  return data.map(({ ccy, amt }) => ({ asset: ccy, amount: amt }));
}

/** 鏈上賺幣進行中的投入本金；尚未發放的收益不列入。 */
export async function fetchStakingBalances(
  options: OkxClientOptions,
): Promise<ExchangeBalance[]> {
  const data = parse(
    z.array(
      z.object({
        investData: z.array(z.object({ ccy: z.string(), amt: decimalSchema })),
      }),
    ),
    await request(
      "/api/v5/finance/staking-defi/orders-active",
      {},
      options,
      true,
    ),
    "鏈上賺幣",
  );
  return data.flatMap(({ investData }) =>
    investData.map(({ ccy, amt }) => ({ asset: ccy, amount: amt })),
  );
}

/** 全部現貨交易對的最新成交價；公開端點，限流時短暫等待後重試。 */
export async function fetchTickerPrices(options: OkxClientOptions) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const data = parse(
        z.array(z.object({ instId: z.string(), last: decimalSchema })),
        await request(
          "/api/v5/market/tickers",
          { instType: "SPOT" },
          options,
          false,
        ),
        "報價",
      );
      return new Map(data.map(({ instId, last }) => [instId, last]));
    } catch (error) {
      if (
        !(error instanceof OkxApiError && error.retryable) ||
        attempt >= PUBLIC_RATE_LIMIT_RETRIES
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, PUBLIC_RATE_LIMIT_WAIT_MS),
      );
      options.signal?.throwIfAborted();
    }
  }
}

/** 歷史紀錄單頁上限。 */
export const HISTORY_PAGE_LIMIT = 100;

const depositSchema = z.object({
  depId: z.string(),
  ccy: z.string(),
  chain: z.string().optional(),
  amt: decimalSchema,
  txId: z.string().optional(),
  state: z.string(),
  ts: z.string().regex(/^\d+$/).transform(Number),
});

const withdrawalSchema = z.object({
  wdId: z.string(),
  ccy: z.string(),
  chain: z.string().optional(),
  amt: decimalSchema,
  fee: decimalSchema.optional(),
  txId: z.string().optional(),
  to: z.string().optional(),
  state: z.string(),
  ts: z.string().regex(/^\d+$/).transform(Number),
});

export type OkxDeposit = z.infer<typeof depositSchema>;
export type OkxWithdrawal = z.infer<typeof withdrawalSchema>;

/** 入金紀錄，由新到舊；`after` 只回傳早於該時間（epoch ms）的紀錄。 */
export async function fetchDeposits(
  after: number | undefined,
  options: OkxClientOptions,
) {
  return parse(
    z.array(depositSchema),
    await request(
      "/api/v5/asset/deposit-history",
      { limit: HISTORY_PAGE_LIMIT, after },
      options,
      true,
    ),
    "入金紀錄",
  );
}

/** 提領紀錄，由新到舊；`after` 只回傳早於該時間（epoch ms）的紀錄。 */
export async function fetchWithdrawals(
  after: number | undefined,
  options: OkxClientOptions,
) {
  return parse(
    z.array(withdrawalSchema),
    await request(
      "/api/v5/asset/withdrawal-history",
      { limit: HISTORY_PAGE_LIMIT, after },
      options,
      true,
    ),
    "提領紀錄",
  );
}
