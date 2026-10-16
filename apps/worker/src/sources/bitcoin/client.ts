import { z } from "zod";
import {
  fetchWalletJson,
  WalletApiError,
  type HistoryPage,
} from "../onchain-wallet";

/** mempool.space 公開 Esplora API；不需要 API key。 */
export const MEMPOOL_API_URL = "https://mempool.space/api";

/** `/txs/chain` 每頁固定回傳 25 筆已確認交易。 */
const CHAIN_PAGE_SIZE = 25;

const LABEL = "比特幣區塊鏈查詢服務（mempool.space）";

const addressStatsSchema = z.object({
  chain_stats: z.object({
    funded_txo_sum: z.number().int().nonnegative(),
    spent_txo_sum: z.number().int().nonnegative(),
  }),
});

const outputSchema = z.object({
  scriptpubkey_address: z.string().optional(),
  value: z.number().int().nonnegative(),
});

const bitcoinTransactionSchema = z.object({
  txid: z.string().regex(/^[0-9a-f]{64}$/),
  fee: z.number().int().nonnegative(),
  vin: z.array(
    z.object({
      // Coinbase 交易沒有 prevout。
      prevout: outputSchema.nullable().optional(),
    }),
  ),
  vout: z.array(outputSchema),
  status: z.object({
    confirmed: z.boolean(),
    block_height: z.number().int().optional(),
    block_time: z.number().int().optional(),
  }),
});

export type BitcoinTransaction = z.infer<typeof bitcoinTransactionSchema>;

type ClientOptions = { fetcher?: typeof fetch; signal?: AbortSignal };

/** 已確認的地址餘額（satoshi）；未確認交易不計入。 */
export async function fetchBitcoinBalance(
  address: string,
  options: ClientOptions = {},
) {
  const payload = await fetchWalletJson(
    `${MEMPOOL_API_URL}/address/${encodeURIComponent(address)}`,
    { ...options, label: LABEL },
  );
  const parsed = addressStatsSchema.safeParse(payload);
  if (!parsed.success) throw new WalletApiError(`${LABEL}回應格式無法辨識。`);
  const { funded_txo_sum, spent_txo_sum } = parsed.data.chain_stats;
  return BigInt(funded_txo_sum) - BigInt(spent_txo_sum);
}

/** 由新到舊的已確認交易；`next` 是本頁最後一筆 txid。 */
export async function fetchBitcoinTransactionPage(
  address: string,
  next: string | null,
  options: ClientOptions = {},
): Promise<HistoryPage<BitcoinTransaction>> {
  const path = `${MEMPOOL_API_URL}/address/${encodeURIComponent(address)}/txs/chain`;
  const payload = await fetchWalletJson(
    next ? `${path}/${encodeURIComponent(next)}` : path,
    { ...options, label: LABEL },
  );
  const parsed = z.array(bitcoinTransactionSchema).safeParse(payload);
  if (!parsed.success) throw new WalletApiError(`${LABEL}回應格式無法辨識。`);
  const items = parsed.data.filter(
    (transaction) =>
      transaction.status.confirmed &&
      transaction.status.block_height !== undefined &&
      transaction.status.block_time !== undefined,
  );
  return {
    items,
    next:
      parsed.data.length >= CHAIN_PAGE_SIZE
        ? (parsed.data.at(-1)?.txid ?? null)
        : null,
  };
}

const usdPriceSchema = z.object({
  time: z.number().int().positive(),
  USD: z.number().positive(),
});

/** mempool.space 的 BTC 美元報價；與地址查詢同一服務，避免另外依賴交易所 API。 */
export async function fetchBitcoinUsdPrice(options: ClientOptions = {}) {
  const payload = await fetchWalletJson(`${MEMPOOL_API_URL}/v1/prices`, {
    ...options,
    label: LABEL,
  });
  const parsed = usdPriceSchema.safeParse(payload);
  if (!parsed.success) throw new WalletApiError(`${LABEL}報價格式無法辨識。`);
  return {
    priceUsd: parsed.data.USD,
    at: new Date(parsed.data.time * 1000).toISOString(),
    source: "mempool.space",
  };
}
