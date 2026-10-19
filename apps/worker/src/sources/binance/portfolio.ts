import {
  DAY_MS,
  historyStart,
  type ExchangeTransfer,
} from "../exchange-account";
import { maskAddress } from "../onchain-wallet";
import type { BinanceDeposit, BinanceWithdrawal } from "./client";

/**
 * 幣安專用的純邏輯：入出金正規化與 90 天查詢區間。跨交易所的彙總與估值見
 * `sources/exchange-account.ts`；同步協調見 `sync.ts`。
 */

/** 現貨帳戶的 `LD` 開頭資產是活期理財的憑證，與理財持倉重複。 */
export function isBinanceDuplicateAsset(wallet: string, asset: string) {
  return wallet === "spot" && asset.startsWith("LD");
}

/** 幣安交易對代號，例如 `BTCUSDT`。 */
export function binancePair(base: string, quote: string) {
  return `${base}${quote}`;
}

/** 1：入帳成功；6：已入帳但尚未解鎖提領。其餘為處理中、失敗或待確認。 */
const COMPLETED_DEPOSIT_STATUSES = new Set([1, 6]);
/** 6：提領完成。 */
const COMPLETED_WITHDRAWAL_STATUS = 6;

export function depositTransfer(
  deposit: BinanceDeposit,
): ExchangeTransfer | null {
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
): ExchangeTransfer | null {
  if (withdrawal.status !== COMPLETED_WITHDRAWAL_STATUS) return null;
  // applyTime 為 UTC 的 `YYYY-MM-DD HH:mm:ss`。
  const occurredAt = new Date(`${withdrawal.applyTime.replace(" ", "T")}Z`);
  if (Number.isNaN(occurredAt.getTime())) return null;
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
      address: withdrawal.address ? maskAddress(withdrawal.address) : null,
      status: withdrawal.status,
    },
  };
}

/** 幣安單次查詢區間須小於 90 天。 */
export const HISTORY_WINDOW_DAYS = 89;

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
  const windows: Array<{ start: number; end: number }> = [];
  for (
    let from = historyStart(cursor.historySyncedUntil, now);
    from < now;
    from += HISTORY_WINDOW_DAYS * DAY_MS
  ) {
    windows.push({
      start: from,
      end: Math.min(from + HISTORY_WINDOW_DAYS * DAY_MS, now),
    });
  }
  return windows;
}
