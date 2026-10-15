import { z } from "zod";

/**
 * 加密貨幣的新台幣報價。使用 MAX 交易所的公開行情：直接以 TWD 報價、
 * 不需要 API key，也沒有地區封鎖。每次只發出一個請求。
 */
export const MAX_TICKERS_URL = "https://max-api.maicoin.com/api/v3/tickers";

const PRICE_TIMEOUT_MS = 10_000;

const tickersSchema = z.array(
  z.object({
    market: z.string(),
    at: z.number(),
    last: z.string(),
  }),
);

export type CryptoTwdPrice = {
  symbol: string;
  priceTwd: number;
  /** 報價時間（ISO）。 */
  at: string;
  source: "max";
};

export class CryptoPriceUnavailableError extends Error {
  constructor(message = "加密貨幣報價暫時無法取得，請稍後再試。") {
    super(message);
    this.name = "CryptoPriceUnavailableError";
  }
}

export async function fetchCryptoTwdPrices(
  symbols: readonly string[],
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Record<string, CryptoTwdPrice>> {
  const fetcher = options.fetcher ?? fetch;
  const url = new URL(MAX_TICKERS_URL);
  for (const symbol of symbols) {
    url.searchParams.append("markets[]", `${symbol.toLowerCase()}twd`);
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(PRICE_TIMEOUT_MS)])
    : AbortSignal.timeout(PRICE_TIMEOUT_MS);

  let payload: unknown;
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw new CryptoPriceUnavailableError(
        `加密貨幣報價來源回應 HTTP ${response.status}，請稍後再試。`,
      );
    }
    payload = await response.json();
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof CryptoPriceUnavailableError) throw error;
    throw new CryptoPriceUnavailableError();
  }

  const parsed = tickersSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CryptoPriceUnavailableError("加密貨幣報價格式無法辨識。");
  }

  const prices: Record<string, CryptoTwdPrice> = {};
  for (const symbol of symbols) {
    const ticker = parsed.data.find(
      ({ market }) => market === `${symbol.toLowerCase()}twd`,
    );
    const priceTwd = Number(ticker?.last);
    if (!ticker || !Number.isFinite(priceTwd) || priceTwd <= 0) {
      throw new CryptoPriceUnavailableError(
        `無法取得 ${symbol} 的新台幣報價。`,
      );
    }
    prices[symbol] = {
      symbol,
      priceTwd,
      at: new Date(ticker.at * 1000).toISOString(),
      source: "max",
    };
  }
  return prices;
}
