import type {
  BinanceDeposit,
  BinanceWalletBalance,
  BinanceWithdrawal,
} from "./client";

/**
 * 幣安同步的純邏輯：跨錢包彙總餘額、美元報價、入出金正規化與歷史查詢區間。
 * 不依賴 D1、Worker Env 或網路；同步協調見 `sync.ts`。
 */

export type BinanceWalletName =
  "spot" | "funding" | "earnFlexible" | "earnLocked";

export type BinanceHolding = {
  asset: string;
  quantity: number;
  wallets: Partial<Record<BinanceWalletName, number>>;
};

const QUANTITY_DECIMALS = 1e8;

function roundQuantity(value: number) {
  return Math.round(value * QUANTITY_DECIMALS) / QUANTITY_DECIMALS;
}

/**
 * 以幣別彙總各錢包餘額。現貨帳戶的 `LD` 開頭資產是活期理財的憑證，
 * 與理財持倉重複，因此略過。
 */
export function aggregateHoldings(
  wallets: Record<BinanceWalletName, BinanceWalletBalance[]>,
): BinanceHolding[] {
  const holdings = new Map<string, BinanceHolding>();
  for (const [wallet, balances] of Object.entries(wallets) as Array<
    [BinanceWalletName, BinanceWalletBalance[]]
  >) {
    for (const { asset, amount } of balances) {
      if (!(amount > 0)) continue;
      if (wallet === "spot" && asset.startsWith("LD")) continue;
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

export type BinanceUsdPrice = { priceUsd: number; pair: string };

/**
 * 以幣安交易對估算美元價格：優先使用穩定幣交易對，沒有時經 BTC 交叉換算。
 * 穩定幣與美元的微小價差不另外校正。
 */
export function binanceUsdPrice(
  asset: string,
  tickers: ReadonlyMap<string, number>,
): BinanceUsdPrice | undefined {
  if (asset === "USDT") return { priceUsd: 1, pair: "USDT" };
  for (const quote of USD_QUOTES) {
    const price = tickers.get(`${asset}${quote}`);
    if (price && price > 0)
      return { priceUsd: price, pair: `${asset}${quote}` };
  }
  const btcPrice = tickers.get(`${asset}BTC`);
  const btcUsd = tickers.get("BTCUSDT");
  if (btcPrice && btcPrice > 0 && btcUsd && btcUsd > 0) {
    return { priceUsd: btcPrice * btcUsd, pair: `${asset}BTC×BTCUSDT` };
  }
  return undefined;
}

export type BinanceTransfer = {
  sourceId: string;
  kind: "deposit" | "withdraw";
  asset: string;
  occurredAt: string;
  /** 入金為正、提領為負；提領手續費另記於 raw。 */
  quantity: number;
  raw: Record<string, unknown>;
};

/** 1：入帳成功；6：已入帳但尚未解鎖提領。其餘為處理中、失敗或待確認。 */
const COMPLETED_DEPOSIT_STATUSES = new Set([1, 6]);
/** 6：提領完成。 */
const COMPLETED_WITHDRAWAL_STATUS = 6;

export function depositTransfer(
  deposit: BinanceDeposit,
): BinanceTransfer | null {
  if (!COMPLETED_DEPOSIT_STATUSES.has(deposit.status)) return null;
  return {
    sourceId: `deposit:${deposit.id}`,
    kind: "deposit",
    asset: deposit.coin,
    occurredAt: new Date(deposit.insertTime).toISOString(),
    quantity: Number(deposit.amount),
    raw: {
      network: deposit.network ?? null,
      txId: deposit.txId ?? null,
      status: deposit.status,
    },
  };
}

export function withdrawalTransfer(
  withdrawal: BinanceWithdrawal,
): BinanceTransfer | null {
  if (withdrawal.status !== COMPLETED_WITHDRAWAL_STATUS) return null;
  // applyTime 為 UTC 的 `YYYY-MM-DD HH:mm:ss`。
  const occurredAt = new Date(`${withdrawal.applyTime.replace(" ", "T")}Z`);
  if (Number.isNaN(occurredAt.getTime())) return null;
  const address = withdrawal.address ?? "";
  return {
    sourceId: `withdraw:${withdrawal.id}`,
    kind: "withdraw",
    asset: withdrawal.coin,
    occurredAt: occurredAt.toISOString(),
    quantity: -Number(withdrawal.amount),
    raw: {
      network: withdrawal.network ?? null,
      txId: withdrawal.txId ?? null,
      fee: Number(withdrawal.transactionFee ?? 0),
      address:
        address.length > 12
          ? `${address.slice(0, 6)}…${address.slice(-4)}`
          : address || null,
      status: withdrawal.status,
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 首次同步回溯的入出金歷史。 */
export const INITIAL_HISTORY_DAYS = 365;
/** 幣安單次查詢區間須小於 90 天。 */
export const HISTORY_WINDOW_DAYS = 89;
/** 重疊前次查詢的天數，補上當時仍在處理中、之後才完成的入出金。 */
export const HISTORY_OVERLAP_DAYS = 7;

export type BinanceCursor = {
  version: 1;
  /** 入出金紀錄已完整查詢到的時間（epoch ms）。 */
  historySyncedUntil?: number;
};

export function parseBinanceCursor(value: string | null): BinanceCursor {
  if (!value) return { version: 1 };
  try {
    const parsed = JSON.parse(value) as Partial<BinanceCursor>;
    return parsed.version === 1 &&
      (parsed.historySyncedUntil === undefined ||
        Number.isSafeInteger(parsed.historySyncedUntil))
      ? { version: 1, historySyncedUntil: parsed.historySyncedUntil }
      : { version: 1 };
  } catch {
    return { version: 1 };
  }
}

/** 由舊到新的查詢區間，讓中途停止時 cursor 仍可停在已完成的位置。 */
export function historyWindows(cursor: BinanceCursor, now: number) {
  const start =
    cursor.historySyncedUntil === undefined
      ? now - INITIAL_HISTORY_DAYS * DAY_MS
      : Math.max(
          cursor.historySyncedUntil - HISTORY_OVERLAP_DAYS * DAY_MS,
          now - INITIAL_HISTORY_DAYS * DAY_MS,
        );
  const windows: Array<{ start: number; end: number }> = [];
  for (let from = start; from < now; from += HISTORY_WINDOW_DAYS * DAY_MS) {
    windows.push({
      start: from,
      end: Math.min(from + HISTORY_WINDOW_DAYS * DAY_MS, now),
    });
  }
  return windows;
}
