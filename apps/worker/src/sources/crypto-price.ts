/**
 * 加密貨幣的新台幣估值。報價取自各鏈同步本來就使用的區塊鏈服務（美元計價），
 * 再以資產頁共用的美元匯率換算；台灣交易所的公開行情會拒絕來自 Cloudflare
 * Workers 的請求，因此不直接使用。
 */
export type CryptoUsdQuote = {
  priceUsd: number;
  /** 報價時間（ISO）。 */
  at: string;
  source: string;
};

export type CryptoTwdPrice = CryptoUsdQuote & {
  priceTwd: number;
  usdRateToTwd: number;
  usdRateUpdatedAt: string;
};

export class CryptoPriceUnavailableError extends Error {
  constructor(message = "加密貨幣報價暫時無法取得，請稍後再試。") {
    super(message);
    this.name = "CryptoPriceUnavailableError";
  }
}

export function cryptoTwdPrice(
  quote: CryptoUsdQuote,
  usdRate: { rateTwd: number; updatedAt: string },
): CryptoTwdPrice {
  const priceTwd = quote.priceUsd * usdRate.rateTwd;
  if (!Number.isFinite(priceTwd) || priceTwd <= 0) {
    throw new CryptoPriceUnavailableError("加密貨幣新台幣估值無法計算。");
  }
  return {
    ...quote,
    priceTwd,
    usdRateToTwd: usdRate.rateTwd,
    usdRateUpdatedAt: usdRate.updatedAt,
  };
}
