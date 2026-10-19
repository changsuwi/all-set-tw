/**
 * 交易所帳戶（幣安、OKX）共用的純邏輯：跨錢包彙總餘額、以交易所行情估算
 * 美元價格與入出金型別。不依賴 D1、Worker Env 或網路；寫入見
 * `exchange-account-sync.ts`。
 */

export type ExchangeConnectorId = "binance" | "okx";

/** 單一錢包內某幣別的數量。 */
export type ExchangeBalance = { asset: string; amount: number };

export type ExchangeHolding = {
  asset: string;
  quantity: number;
  /** 各錢包（現貨、資金、理財…）的數量。 */
  wallets: Record<string, number>;
};

const QUANTITY_DECIMALS = 1e8;

export function roundQuantity(value: number) {
  return Math.round(value * QUANTITY_DECIMALS) / QUANTITY_DECIMALS;
}

/** 以幣別彙總各錢包餘額；`skip` 用來排除與其他錢包重複的憑證型資產。 */
export function aggregateHoldings(
  wallets: Record<string, ExchangeBalance[]>,
  skip: (wallet: string, asset: string) => boolean = () => false,
): ExchangeHolding[] {
  const holdings = new Map<string, ExchangeHolding>();
  for (const [wallet, balances] of Object.entries(wallets)) {
    for (const { asset, amount } of balances) {
      if (!(amount > 0) || skip(wallet, asset)) continue;
      const holding = holdings.get(asset) ?? {
        asset,
        quantity: 0,
        wallets: {},
      };
      holding.quantity += amount;
      holding.wallets[wallet] = roundQuantity(
        (holding.wallets[wallet] ?? 0) + amount,
      );
      holdings.set(asset, holding);
    }
  }
  return [...holdings.values()]
    .map((holding) => ({
      ...holding,
      quantity: roundQuantity(holding.quantity),
    }))
    .sort((a, b) => a.asset.localeCompare(b.asset));
}

/** 視為 1 美元的報價幣；USDT 本身沒有對美元的交易對。 */
const USD_QUOTES = ["USDT", "USDC", "FDUSD"] as const;

export type ExchangeUsdPrice = { priceUsd: number; pair: string };

/**
 * 以交易所交易對估算美元價格：優先使用穩定幣交易對，沒有時經 BTC 交叉換算。
 * 穩定幣與美元的微小價差不另外校正。`pairName` 依交易所格式組出交易對代號。
 */
export function exchangeUsdPrice(
  asset: string,
  tickers: ReadonlyMap<string, number>,
  pairName: (base: string, quote: string) => string,
): ExchangeUsdPrice | undefined {
  if (asset === "USDT") return { priceUsd: 1, pair: "USDT" };
  for (const quote of USD_QUOTES) {
    const pair = pairName(asset, quote);
    const price = tickers.get(pair);
    if (price && price > 0) return { priceUsd: price, pair };
  }
  const btcPair = pairName(asset, "BTC");
  const usdPair = pairName("BTC", "USDT");
  const btcPrice = tickers.get(btcPair);
  const btcUsd = tickers.get(usdPair);
  if (btcPrice && btcPrice > 0 && btcUsd && btcUsd > 0) {
    return { priceUsd: btcPrice * btcUsd, pair: `${btcPair}×${usdPair}` };
  }
  return undefined;
}

export type ExchangeTransfer = {
  sourceId: string;
  kind: "deposit" | "withdraw";
  asset: string;
  occurredAt: string;
  /** 入金為正、提領為負；提領手續費另記於 raw。 */
  quantity: number;
  raw: Record<string, unknown>;
};

export const DAY_MS = 24 * 60 * 60 * 1000;
/** 首次同步回溯的入出金歷史。 */
export const INITIAL_HISTORY_DAYS = 365;
/** 重疊前次查詢的天數，補上當時仍在處理中、之後才完成的入出金。 */
export const HISTORY_OVERLAP_DAYS = 7;

/** 本次入出金查詢的起點（epoch ms）。 */
export function historyStart(syncedUntil: number | undefined, now: number) {
  const earliest = now - INITIAL_HISTORY_DAYS * DAY_MS;
  return syncedUntil === undefined
    ? earliest
    : Math.max(syncedUntil - HISTORY_OVERLAP_DAYS * DAY_MS, earliest);
}
