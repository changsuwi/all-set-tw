import { z } from "zod";
import {
  fetchWalletJson,
  WalletApiError,
  type HistoryPage,
} from "../onchain-wallet";

/** Blockscout 公開 API；不需要 API key，同時提供餘額、一般交易與內部交易。 */
export const BLOCKSCOUT_API_URL = "https://eth.blockscout.com/api/v2";

const LABEL = "以太坊區塊鏈查詢服務（Blockscout）";

const addressRefSchema = z.object({ hash: z.string() }).nullable().optional();

const addressSchema = z.object({
  coin_balance: z.string().regex(/^\d+$/).nullable(),
});

const pageParamsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.null()]))
  .nullable()
  .optional();

const ethereumTransactionSchema = z.object({
  hash: z.string(),
  from: addressRefSchema,
  to: addressRefSchema,
  value: z.string().regex(/^\d+$/),
  fee: z
    .object({ value: z.string().regex(/^\d+$/) })
    .nullable()
    .optional(),
  status: z.string().nullable().optional(),
  timestamp: z.string().nullable().optional(),
  block_number: z.number().int().nullable().optional(),
});

const ethereumInternalTransactionSchema = z.object({
  transaction_hash: z.string(),
  index: z.number().int(),
  from: addressRefSchema,
  to: addressRefSchema,
  value: z.string().regex(/^\d+$/),
  success: z.boolean().nullable().optional(),
  timestamp: z.string().nullable().optional(),
  block_number: z.number().int().nullable().optional(),
});

export type EthereumTransaction = z.infer<typeof ethereumTransactionSchema>;
export type EthereumInternalTransaction = z.infer<
  typeof ethereumInternalTransactionSchema
>;

type ClientOptions = { fetcher?: typeof fetch; signal?: AbortSignal };

/** 地址目前的 ETH 餘額（wei）。 */
export async function fetchEthereumBalance(
  address: string,
  options: ClientOptions = {},
) {
  const payload = await fetchWalletJson(
    `${BLOCKSCOUT_API_URL}/addresses/${encodeURIComponent(address)}`,
    { ...options, label: LABEL },
  );
  const parsed = addressSchema.safeParse(payload);
  if (!parsed.success) throw new WalletApiError(`${LABEL}回應格式無法辨識。`);
  return BigInt(parsed.data.coin_balance ?? "0");
}

/** 一般交易，由新到舊；尚未上鏈的交易不納入。 */
export function fetchEthereumTransactionPage(
  address: string,
  next: string | null,
  options: ClientOptions = {},
) {
  return fetchPage(
    address,
    "transactions",
    ethereumTransactionSchema,
    next,
    options,
  );
}

/** 合約轉給地址（或地址經合約轉出）的 ETH，由新到舊。 */
export function fetchEthereumInternalTransactionPage(
  address: string,
  next: string | null,
  options: ClientOptions = {},
) {
  return fetchPage(
    address,
    "internal-transactions",
    ethereumInternalTransactionSchema,
    next,
    options,
  );
}

async function fetchPage<T extends z.ZodType>(
  address: string,
  list: "transactions" | "internal-transactions",
  itemSchema: T,
  next: string | null,
  options: ClientOptions,
): Promise<HistoryPage<z.infer<T>>> {
  const url = new URL(
    `${BLOCKSCOUT_API_URL}/addresses/${encodeURIComponent(address)}/${list}`,
  );
  if (next) {
    for (const [key, value] of Object.entries(
      JSON.parse(next) as Record<string, string | number | null>,
    )) {
      if (value !== null) url.searchParams.set(key, String(value));
    }
  }
  const payload = await fetchWalletJson(url.toString(), {
    ...options,
    label: LABEL,
  });
  const parsed = z
    .object({
      items: z.array(itemSchema),
      next_page_params: pageParamsSchema,
    })
    .safeParse(payload);
  if (!parsed.success) throw new WalletApiError(`${LABEL}回應格式無法辨識。`);
  return {
    items: parsed.data.items.filter((item) => {
      const candidate = item as {
        block_number?: number | null;
        timestamp?: string | null;
      };
      return candidate.block_number != null && Boolean(candidate.timestamp);
    }),
    next: parsed.data.next_page_params
      ? JSON.stringify(parsed.data.next_page_params)
      : null,
  };
}

const statsSchema = z.object({
  coin_price: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .nullable(),
});

/** Blockscout 的 ETH 美元報價；與地址查詢同一服務，避免另外依賴交易所 API。 */
export async function fetchEthereumUsdPrice(options: ClientOptions = {}) {
  const payload = await fetchWalletJson(`${BLOCKSCOUT_API_URL}/stats`, {
    ...options,
    label: LABEL,
  });
  const parsed = statsSchema.safeParse(payload);
  const priceUsd = Number(parsed.data?.coin_price);
  if (!parsed.success || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new WalletApiError(`${LABEL}報價格式無法辨識。`);
  }
  // Blockscout 沒有回傳報價時間，以取得時間代替。
  return { priceUsd, at: new Date().toISOString(), source: "blockscout" };
}
