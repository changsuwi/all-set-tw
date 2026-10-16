/**
 * BTC／ETH 鏈上錢包共用的純邏輯：地址解析、分頁歷史掃描、請求額度與單位換算。
 * 不依賴 D1、Worker Env 或同步流程；同步協調見 `onchain-wallet-sync.ts`。
 */

export type OnchainConnectorId = "bitcoin" | "ethereum";

/** 單一地址設定上限；搭配請求額度確保免費方案每次同步不超過 50 個對外請求。 */
export const MAX_WALLET_ADDRESSES = 20;

/** 每次同步可用的對外請求數（報價 1 個 + 區塊鏈 API），低於免費方案上限 50。 */
export const EXTERNAL_REQUEST_BUDGET = 45;

/** 連續查詢區塊鏈 API 的最小間隔，降低被公開服務限流的機會。 */
export const REQUEST_PACE_MS = 300;

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

export type TransferKind = "receive" | "send" | "self" | "fee";

export const TRANSFER_LABELS: Record<TransferKind, string> = {
  receive: "轉入",
  send: "轉出",
  self: "自有地址互轉",
  fee: "手續費",
};

/** 一筆交易對整組地址造成的淨變化；quantity 以幣為單位，轉出為負。 */
export type WalletTransfer = {
  sourceId: string;
  occurredAt: string;
  kind: TransferKind;
  /** 最小單位（satoshi／wei）的淨變化。 */
  units: bigint;
  /** 由這組地址支付的手續費（最小單位）；未支付時為 0。 */
  feeUnits: bigint;
  raw: Record<string, unknown>;
};

export type WalletBalance = { address: string; units: bigint };

export type WalletCollection = {
  balances: WalletBalance[];
  transfers: WalletTransfer[];
  cursor: WalletCursor;
};

export type HistoryCursor = {
  /** 已完整處理到的最新區塊高度；之後的同步只需往回取到這個高度。 */
  syncedHeight?: number;
  /** 首次同步因額度用完而未取完的較舊歷史續取位置。 */
  backfillNext?: string | null;
  complete?: boolean;
};

/** 以地址雜湊為鍵，cursor 不保存地址本身。 */
export type WalletCursor = {
  version: 1;
  addresses: Record<string, Record<string, HistoryCursor>>;
};

export type HistoryPage<T> = { items: T[]; next: string | null };

/**
 * 單次同步的對外請求額度。公開區塊鏈 API 會依 IP 限流，`paceMs` 讓連續請求
 * 之間保留間隔，避免短時間內大量查詢。
 */
export class RequestBudget {
  private used = 0;

  constructor(
    private remainingRequests: number,
    private readonly paceMs = 0,
  ) {}

  get remaining() {
    return this.remainingRequests;
  }

  async take() {
    if (this.remainingRequests <= 0) return false;
    if (this.used > 0 && this.paceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.paceMs));
    }
    this.remainingRequests -= 1;
    this.used += 1;
    return true;
  }

  /** 遇到限流或暫時性錯誤時停止本次後續查詢，已取得的進度照常保存。 */
  exhaust() {
    this.remainingRequests = 0;
  }
}

export class WalletApiError extends Error {
  constructor(
    message: string,
    /** 限流、5xx 或連線失敗；歷史紀錄可留待下次同步再取。 */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WalletApiError";
  }
}

/** 取得一頁歷史；暫時性錯誤時停止本次額度並回傳 null，讓呼叫端保存既有進度。 */
async function fetchHistoryPage<T>(
  fetchPage: (next: string | null) => Promise<HistoryPage<T>>,
  next: string | null,
  budget: RequestBudget,
) {
  try {
    return await fetchPage(next);
  } catch (error) {
    if (error instanceof WalletApiError && error.retryable) {
      console.warn(`[sync] wallet history paused: ${error.message}`);
      budget.exhaust();
      return null;
    }
    throw error;
  }
}

export function parseAddressLines(value: string | undefined) {
  return [
    ...new Set(
      (value ?? "")
        .split(/[\s,]+/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function taipeiDate(iso: string) {
  return new Date(Date.parse(iso) + TAIPEI_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/** 以字串運算換算，避免 wei 這類大整數在轉成 number 前就失去精度。 */
export function unitsToCoin(units: bigint, decimals: number) {
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals);
  return Number(`${negative ? "-" : ""}${whole}.${fraction}`);
}

export async function addressKey(address: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(address.toLowerCase()),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function maskAddress(address: string) {
  return address.length <= 12
    ? address
    : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function parseWalletCursor(value: string | null): WalletCursor {
  if (!value) return { version: 1, addresses: {} };
  try {
    const parsed = JSON.parse(value) as Partial<WalletCursor>;
    if (
      parsed?.version === 1 &&
      parsed.addresses &&
      typeof parsed.addresses === "object"
    ) {
      return { version: 1, addresses: parsed.addresses };
    }
  } catch {
    // 無法解析的 cursor 視為首次同步，重新取得完整歷史。
  }
  return { version: 1, addresses: {} };
}

/**
 * 由新到舊取得上次同步後的新交易。首次同步會一路往回取，額度用完時記下續取位置；
 * 之後的同步只取到上次處理過的區塊高度。若額度不足以接上舊資料，保留原 cursor
 * 讓下次重新嘗試，不留下缺口。
 */
export async function scanNewHistory<T>(
  state: HistoryCursor,
  fetchPage: (next: string | null) => Promise<HistoryPage<T>>,
  heightOf: (item: T) => number,
  budget: RequestBudget,
): Promise<{ items: T[]; state: HistoryCursor }> {
  const items: T[] = [];
  let next: string | null = null;
  let top: number | undefined;
  const synced = state.syncedHeight;

  while (await budget.take()) {
    const page: HistoryPage<T> | null = await fetchHistoryPage(
      fetchPage,
      next,
      budget,
    );
    if (!page) break;
    items.push(...page.items);
    if (top === undefined) {
      top = page.items.reduce((max, item) => Math.max(max, heightOf(item)), 0);
    }
    if (synced === undefined) {
      if (!page.next) {
        return {
          items,
          state: { syncedHeight: top, backfillNext: null, complete: true },
        };
      }
    } else if (
      !page.next ||
      page.items.some((item) => heightOf(item) <= synced)
    ) {
      return {
        items,
        state: { ...state, syncedHeight: Math.max(synced, top) },
      };
    }
    next = page.next;
  }

  if (synced === undefined && top !== undefined) {
    return {
      items,
      state: { syncedHeight: top, backfillNext: next, complete: false },
    };
  }
  return { items, state };
}

/** 用剩下的額度接續首次同步沒取完的較舊歷史。 */
export async function scanBackfillHistory<T>(
  state: HistoryCursor,
  fetchPage: (next: string | null) => Promise<HistoryPage<T>>,
  budget: RequestBudget,
): Promise<{ items: T[]; state: HistoryCursor }> {
  if (state.complete || !state.backfillNext) return { items: [], state };
  const items: T[] = [];
  let next: string = state.backfillNext;
  while (await budget.take()) {
    const page: HistoryPage<T> | null = await fetchHistoryPage(
      fetchPage,
      next,
      budget,
    );
    if (!page) break;
    items.push(...page.items);
    if (!page.next) {
      return {
        items,
        state: { ...state, backfillNext: null, complete: true },
      };
    }
    next = page.next;
  }
  return { items, state: { ...state, backfillNext: next } };
}

/** 帶逾時、取消與 429／5xx 錯誤轉換的 JSON GET。 */
/** 429 時最多重試的次數；每次重試都要從請求額度扣除。 */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_DEFAULT_WAIT_MS = 1_000;
const RATE_LIMIT_MAX_WAIT_MS = 3_000;

export type WalletRequestOptions = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  /** 有額度時，遇到 429 會依回應的重置時間等待後重試。 */
  budget?: RequestBudget;
};

/**
 * 公開區塊鏈 API 依 IP 以秒為單位限流；Workers 共用 Cloudflare 出口 IP，
 * 容易被其他流量用完額度，短暫等待後通常即可成功。
 */
function rateLimitWaitMs(response: Response) {
  const resetMs = Number(response.headers.get("x-ratelimit-reset"));
  const retryAfterMs = Number(response.headers.get("retry-after")) * 1000;
  const wait = [resetMs, retryAfterMs].find(
    (value) => Number.isFinite(value) && value > 0,
  );
  return Math.min(wait ?? RATE_LIMIT_DEFAULT_WAIT_MS, RATE_LIMIT_MAX_WAIT_MS);
}

export async function fetchWalletJson(
  url: string,
  options: WalletRequestOptions & { label: string },
): Promise<unknown> {
  let response = await requestWalletJson(url, options);
  for (
    let attempt = 0;
    response.status === 429 &&
    attempt < RATE_LIMIT_RETRIES &&
    options.budget &&
    (await options.budget.take());
    attempt += 1
  ) {
    const waitMs = rateLimitWaitMs(response);
    console.warn(
      `[sync] ${options.label} rate limited; retrying in ${waitMs}ms`,
    );
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    options.signal?.throwIfAborted();
    response = await requestWalletJson(url, options);
  }
  if (response.status === 429) {
    throw new WalletApiError(
      `${options.label}查詢過於頻繁，請稍後再試。`,
      true,
    );
  }
  if (!response.ok) {
    throw new WalletApiError(
      `${options.label}回應 HTTP ${response.status}，請確認地址是否正確或稍後再試。`,
      response.status >= 500,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new WalletApiError(`${options.label}回應格式無法辨識。`);
  }
}

async function requestWalletJson(
  url: string,
  options: WalletRequestOptions & { label: string },
) {
  const fetcher = options.fetcher ?? fetch;
  const timeout = AbortSignal.timeout(15_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    return await fetcher(url, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new WalletApiError(
      `${options.label}暫時無法連線，請稍後再試。`,
      true,
    );
  }
}
