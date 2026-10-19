import { z } from "zod";
import { BINANCE_EGRESS_HOST } from "../../platform/binance-egress";
import type { RequestBudget } from "../onchain-wallet";

/**
 * 幣安 REST API。所有請求經 `BinanceEgress` Durable Object 從亞太機房送出，
 * 並使用 GCP 版 host；其他 host 與美國機房分別回應 HTTP 403／451。
 */
export const BINANCE_API_URL = `https://${BINANCE_EGRESS_HOST}`;

/** 伺服器時間與 Worker 時鐘允許的誤差。 */
const RECV_WINDOW_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** 幣安以這些代碼表示 API key 無效、簽章錯誤或權限不足，需要使用者處理。 */
const AUTH_ERROR_CODES = new Set([-1002, -1022, -2008, -2014, -2015]);

export class BinanceApiError extends Error {
  constructor(
    message: string,
    /** 限流、5xx、時鐘誤差或連線失敗；下次同步通常可成功。 */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BinanceApiError";
  }
}

export class BinanceAuthError extends BinanceApiError {
  constructor() {
    super(
      "幣安 API key 無效、已刪除或缺少讀取權限，請在資料來源設定重新填寫。",
    );
    this.name = "BinanceAuthError";
  }
}

export type BinanceCredentials = { apiKey: string; apiSecret: string };

export type BinanceClientOptions = {
  fetcher: typeof fetch;
  credentials: BinanceCredentials;
  budget: RequestBudget;
  signal?: AbortSignal;
};

const decimalSchema = z.string().regex(/^\d+(\.\d+)?$/);
const errorSchema = z.object({ code: z.number(), msg: z.string() });

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
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function request(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number>,
  options: BinanceClientOptions,
  signed: boolean,
): Promise<unknown> {
  if (!(await options.budget.take())) {
    throw new BinanceApiError("幣安查詢次數超過單次同步上限。", true);
  }
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  );
  const headers: Record<string, string> = { Accept: "application/json" };
  if (signed) {
    query.set("recvWindow", String(RECV_WINDOW_MS));
    query.set("timestamp", String(Date.now()));
    query.set(
      "signature",
      await sign(options.credentials.apiSecret, query.toString()),
    );
    headers["X-MBX-APIKEY"] = options.credentials.apiKey;
  }
  const url = `${BINANCE_API_URL}${path}${query.size > 0 ? `?${query}` : ""}`;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await options.fetcher(url, {
      method,
      headers,
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new BinanceApiError("幣安暫時無法連線，請稍後再試。", true);
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (response.ok && payload !== undefined) return payload;

  const error = errorSchema.safeParse(payload);
  if (error.success && AUTH_ERROR_CODES.has(error.data.code)) {
    throw new BinanceAuthError();
  }
  if (response.status === 429 || response.status === 418) {
    throw new BinanceApiError("幣安查詢過於頻繁，請稍後再試。", true);
  }
  if (response.status === 403 || response.status === 451) {
    throw new BinanceApiError(
      `幣安拒絕來自目前伺服器位置的連線（HTTP ${response.status}）。`,
    );
  }
  if (error.success && error.data.code === -1021) {
    throw new BinanceApiError(
      "幣安伺服器時間與本機誤差過大，請稍後再試。",
      true,
    );
  }
  // 錯誤訊息只記代碼，避免把回應內容寫入 log 或同步結果。
  throw new BinanceApiError(
    `幣安回應 HTTP ${response.status}${error.success ? `（${error.data.code}）` : ""}，請稍後再試。`,
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
    throw new BinanceApiError(`幣安${label}回應格式無法辨識。`);
  }
  return parsed.data as z.infer<T>;
}

export type BinanceWalletBalance = { asset: string; amount: number };

/** 現貨帳戶（可用 + 凍結）。 */
export async function fetchSpotBalances(
  options: BinanceClientOptions,
): Promise<BinanceWalletBalance[]> {
  const payload = await request(
    "GET",
    "/api/v3/account",
    { omitZeroBalances: "true" },
    options,
    true,
  );
  const data = parse(
    z.object({
      balances: z.array(
        z.object({
          asset: z.string(),
          free: decimalSchema,
          locked: decimalSchema,
        }),
      ),
    }),
    payload,
    "現貨帳戶",
  );
  return data.balances.map((balance) => ({
    asset: balance.asset,
    amount: Number(balance.free) + Number(balance.locked),
  }));
}

/** 資金帳戶（可用、凍結、委託中與提領中都仍屬於使用者）。 */
export async function fetchFundingBalances(
  options: BinanceClientOptions,
): Promise<BinanceWalletBalance[]> {
  const payload = await request(
    "POST",
    "/sapi/v1/asset/get-funding-asset",
    {},
    options,
    true,
  );
  const data = parse(
    z.array(
      z.object({
        asset: z.string(),
        free: decimalSchema,
        locked: decimalSchema,
        freeze: decimalSchema,
        withdrawing: decimalSchema,
      }),
    ),
    payload,
    "資金帳戶",
  );
  return data.map((balance) => ({
    asset: balance.asset,
    amount:
      Number(balance.free) +
      Number(balance.locked) +
      Number(balance.freeze) +
      Number(balance.withdrawing),
  }));
}

const EARN_PAGE_SIZE = 100;
const EARN_MAX_PAGES = 3;

/** 理財（Simple Earn）活期與定期持倉。 */
export async function fetchEarnBalances(
  product: "flexible" | "locked",
  options: BinanceClientOptions,
): Promise<BinanceWalletBalance[]> {
  const rowSchema =
    product === "flexible"
      ? z.object({ asset: z.string(), totalAmount: decimalSchema })
      : z.object({ asset: z.string(), amount: decimalSchema });
  const balances: BinanceWalletBalance[] = [];
  for (let current = 1; current <= EARN_MAX_PAGES; current += 1) {
    const payload = await request(
      "GET",
      `/sapi/v1/simple-earn/${product}/position`,
      { current, size: EARN_PAGE_SIZE },
      options,
      true,
    );
    const data = parse(
      z.object({ rows: z.array(rowSchema), total: z.number().int() }),
      payload,
      product === "flexible" ? "活期理財" : "定期理財",
    );
    for (const row of data.rows) {
      balances.push({
        asset: row.asset,
        amount: Number("totalAmount" in row ? row.totalAmount : row.amount),
      });
    }
    if (current * EARN_PAGE_SIZE >= data.total) return balances;
  }
  // 不完整的持倉會低估資產，寧可整次失敗。
  throw new BinanceApiError("幣安理財持倉筆數超過支援上限。");
}

/** 全部交易對的最新成交價；公開端點，不需簽章。 */
export async function fetchTickerPrices(options: BinanceClientOptions) {
  const payload = await request(
    "GET",
    "/api/v3/ticker/price",
    {},
    options,
    false,
  );
  const data = parse(
    z.array(z.object({ symbol: z.string(), price: decimalSchema })),
    payload,
    "報價",
  );
  return new Map(data.map(({ symbol, price }) => [symbol, Number(price)]));
}

/** 單次歷史查詢的筆數上限；回傳滿額時代表區間內可能還有更多紀錄。 */
export const HISTORY_PAGE_LIMIT = 1000;

const depositSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  amount: decimalSchema,
  coin: z.string(),
  network: z.string().nullable().optional(),
  status: z.number().int(),
  txId: z.string().nullable().optional(),
  insertTime: z.number().int(),
});

const withdrawalSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  amount: decimalSchema,
  transactionFee: decimalSchema.nullable().optional(),
  coin: z.string(),
  network: z.string().nullable().optional(),
  status: z.number().int(),
  txId: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  applyTime: z.string(),
});

export type BinanceDeposit = z.infer<typeof depositSchema>;
export type BinanceWithdrawal = z.infer<typeof withdrawalSchema>;

/** 入金紀錄；幣安限制單次查詢區間不得超過 90 天。 */
export async function fetchDeposits(
  startTime: number,
  endTime: number,
  options: BinanceClientOptions,
) {
  const payload = await request(
    "GET",
    "/sapi/v1/capital/deposit/hisrec",
    { startTime, endTime, limit: HISTORY_PAGE_LIMIT },
    options,
    true,
  );
  return parse(z.array(depositSchema), payload, "入金紀錄");
}

/** 提領紀錄；幣安限制單次查詢區間不得超過 90 天。 */
export async function fetchWithdrawals(
  startTime: number,
  endTime: number,
  options: BinanceClientOptions,
) {
  const payload = await request(
    "GET",
    "/sapi/v1/capital/withdraw/history",
    { startTime, endTime, limit: HISTORY_PAGE_LIMIT },
    options,
    true,
  );
  return parse(z.array(withdrawalSchema), payload, "提領紀錄");
}
