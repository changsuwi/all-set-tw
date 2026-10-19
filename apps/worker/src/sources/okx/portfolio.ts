import { OKX_API_HOSTS, type OkxApiHost } from "../../platform/okx-egress";
import type { ExchangeTransfer } from "../exchange-account";
import { maskAddress } from "../onchain-wallet";
import type { OkxDeposit, OkxWithdrawal } from "./client";

/**
 * OKX 專用的純邏輯：交易對格式、入出金正規化與 cursor。跨交易所的彙總與
 * 估值見 `sources/exchange-account.ts`；同步協調見 `sync.ts`。
 */

/** OKX 交易對代號，例如 `BTC-USDT`。 */
export function okxPair(base: string, quote: string) {
  return `${base}-${quote}`;
}

/** 入金與提領的 state `2` 皆為成功；其餘為處理中、失敗或被凍結。 */
const COMPLETED_STATE = "2";

export function depositTransfer(deposit: OkxDeposit): ExchangeTransfer | null {
  if (deposit.state !== COMPLETED_STATE) return null;
  return {
    sourceId: `deposit:${deposit.depId}`,
    kind: "deposit",
    asset: deposit.ccy,
    occurredAt: new Date(deposit.ts).toISOString(),
    quantity: deposit.amt,
    raw: {
      network: deposit.chain || null,
      txId: deposit.txId || null,
      state: deposit.state,
    },
  };
}

export function withdrawalTransfer(
  withdrawal: OkxWithdrawal,
): ExchangeTransfer | null {
  if (withdrawal.state !== COMPLETED_STATE) return null;
  return {
    sourceId: `withdraw:${withdrawal.wdId}`,
    kind: "withdraw",
    asset: withdrawal.ccy,
    occurredAt: new Date(withdrawal.ts).toISOString(),
    quantity: -withdrawal.amt,
    raw: {
      network: withdrawal.chain || null,
      txId: withdrawal.txId || null,
      fee: withdrawal.fee ?? 0,
      address: withdrawal.to ? maskAddress(withdrawal.to) : null,
      state: withdrawal.state,
    },
  };
}

export type OkxCursor = {
  version: 1;
  /** 這把 API key 所屬的地區站；變更 key 時 cursor 會清除並重新偵測。 */
  apiHost?: OkxApiHost;
  /** 入出金紀錄已完整查詢到的時間（epoch ms）。 */
  historySyncedUntil?: number;
};

export function parseOkxCursor(value: string | null): OkxCursor {
  if (!value) return { version: 1 };
  try {
    const parsed = JSON.parse(value) as Partial<OkxCursor>;
    if (parsed.version !== 1) return { version: 1 };
    return {
      version: 1,
      apiHost: (OKX_API_HOSTS as readonly unknown[]).includes(parsed.apiHost)
        ? parsed.apiHost
        : undefined,
      historySyncedUntil: Number.isSafeInteger(parsed.historySyncedUntil)
        ? parsed.historySyncedUntil
        : undefined,
    };
  } catch {
    return { version: 1 };
  }
}

/** 偵測地區站時的嘗試順序：上次成功的站優先。 */
export function okxHostOrder(preferred: OkxApiHost | undefined) {
  return preferred
    ? [preferred, ...OKX_API_HOSTS.filter((host) => host !== preferred)]
    : [...OKX_API_HOSTS];
}
