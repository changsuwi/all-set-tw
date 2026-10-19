import type { SyncTrigger } from "../../db";
import type { Env } from "../../platform/env";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson } from "../../platform/crypto";
import { createOkxEgressFetcher } from "../../platform/okx-egress";
import { requireConnectorSettings } from "../../features/sync/config";
import { NeedsUserActionError } from "../../features/sync/errors";
import type { SyncEnv } from "../../features/sync/execution";
import type { SyncOutcome } from "../../features/sync/types";
import {
  aggregateHoldings,
  exchangeUsdPrice,
  historyStart,
  type ExchangeBalance,
  type ExchangeTransfer,
} from "../exchange-account";
import {
  cryptoUsdRate,
  persistExchangeSnapshot,
} from "../exchange-account-sync";
import { EXTERNAL_REQUEST_BUDGET, RequestBudget } from "../onchain-wallet";
import { reportSyncProgress } from "../sync-progress";
import {
  fetchDeposits,
  fetchFundingBalances,
  fetchSavingsBalances,
  fetchStakingBalances,
  fetchTickerPrices,
  fetchTradingBalances,
  fetchWithdrawals,
  HISTORY_PAGE_LIMIT,
  OKX_KEY_NOT_FOUND,
  OkxApiError,
  OkxAuthError,
  type OkxClientOptions,
} from "./client";
import {
  depositTransfer,
  okxHostOrder,
  okxPair,
  parseOkxCursor,
  withdrawalTransfer,
  type OkxCursor,
} from "./portfolio";
import { parseOkxConfig } from "./protocol";

const CONNECTOR_ID = "okx";

export async function syncOkx(
  env: Env,
  trigger: SyncTrigger,
  fetcher: typeof fetch = createOkxEgressFetcher(env.OKX_EGRESS),
): Promise<SyncOutcome> {
  const settings = await requireConnectorSettings(env.DB, CONNECTOR_ID);
  const config = parseOkxConfig(
    await decryptJson<Record<string, unknown>>(
      settings.encrypted_config,
      configEncryptionKey(env),
    ),
  );
  if (!config.apiKey || !config.apiSecret || !config.passphrase) {
    throw new NeedsUserActionError(
      "請先在資料來源設定填寫 OKX API Key、Secret Key 與 Passphrase。",
    );
  }
  const signal = (env as SyncEnv).syncSignal;
  const previousCursor = parseOkxCursor(settings.sync_cursor);
  console.log(
    `[sync] ${CONNECTOR_ID}/all: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );
  reportSyncProgress("fetching");

  // 匯率更新保留一個對外請求，其餘給 OKX API。
  const budget = new RequestBudget(EXTERNAL_REQUEST_BUDGET - 1);
  const credentials = {
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    passphrase: config.passphrase,
  };

  let options: OkxClientOptions | undefined;
  let trading: ExchangeBalance[] = [];
  let holdings;
  let tickers;
  try {
    // API key 只在建立它的地區站有效；以第一個帳戶查詢偵測所屬的站。
    for (const host of okxHostOrder(previousCursor.apiHost)) {
      const candidate = { fetcher, host, credentials, budget, signal };
      try {
        trading = await fetchTradingBalances(candidate);
        options = candidate;
        break;
      } catch (error) {
        if (error instanceof OkxApiError) {
          // 只記錯誤代碼與站名，不記 key 或回應內容。
          console.warn(
            `[sync] ${CONNECTOR_ID}/all: ${host} rejected code=${error.code}`,
          );
        }
        if (!(
          error instanceof OkxApiError && error.code === OKX_KEY_NOT_FOUND
        )) {
          throw error;
        }
      }
    }
    if (!options) throw new OkxAuthError(OKX_KEY_NOT_FOUND);
    holdings = aggregateHoldings({
      trading,
      funding: await fetchFundingBalances(options),
      savings: await fetchSavingsBalances(options),
      staking: await fetchStakingBalances(options),
    });
    tickers = await fetchTickerPrices(options);
  } catch (error) {
    if (error instanceof OkxAuthError) {
      throw new NeedsUserActionError(error.message);
    }
    throw error;
  }
  const usdRate = await cryptoUsdRate(env, signal);
  const history = await collectHistory(previousCursor, options);

  return persistExchangeSnapshot(env, {
    connectorId: CONNECTOR_ID,
    brokerName: "OKX",
    priceSource: "okx",
    settings,
    holdings,
    priceOf: (asset) => exchangeUsdPrice(asset, tickers, okxPair),
    usdRate,
    transfers: history.transfers,
    cursor: { ...history.cursor, apiHost: options.host } satisfies OkxCursor,
    requestsLeft: budget.remaining,
  });
}

/**
 * 由新到舊分頁查詢入出金，直到早於本次起點。兩類都完整取得才推進 cursor；
 * 額度用完或暫時性錯誤時保留舊 cursor，已取得的紀錄照常寫入（以來源 id 去重）。
 */
async function collectHistory(
  cursor: OkxCursor,
  options: OkxClientOptions,
): Promise<{ transfers: ExchangeTransfer[]; cursor: OkxCursor }> {
  const now = Date.now();
  const since = historyStart(cursor.historySyncedUntil, now);
  const transfers = new Map<string, ExchangeTransfer>();
  const collect = (transfer: ExchangeTransfer | null) => {
    if (transfer) transfers.set(transfer.sourceId, transfer);
  };
  let complete: boolean;
  try {
    const deposits = await scanHistory(since, (after) =>
      fetchDeposits(after, options),
    );
    deposits.items.forEach((item) => collect(depositTransfer(item)));
    const withdrawals = await scanHistory(since, (after) =>
      fetchWithdrawals(after, options),
    );
    withdrawals.items.forEach((item) => collect(withdrawalTransfer(item)));
    complete = deposits.complete && withdrawals.complete;
  } catch (error) {
    if (!(error instanceof OkxApiError && error.retryable)) throw error;
    console.warn(`[sync] ${CONNECTOR_ID} history paused: ${error.message}`);
    complete = false;
  }
  return {
    transfers: [...transfers.values()],
    cursor: {
      version: 1,
      historySyncedUntil: complete ? now : cursor.historySyncedUntil,
    },
  };
}

async function scanHistory<T extends { ts: number }>(
  since: number,
  fetchPage: (after: number | undefined) => Promise<T[]>,
) {
  const items: T[] = [];
  let after: number | undefined;
  for (;;) {
    const page = await fetchPage(after);
    items.push(...page.filter(({ ts }) => ts >= since));
    if (page.length < HISTORY_PAGE_LIMIT) return { items, complete: true };
    const oldest = Math.min(...page.map(({ ts }) => ts));
    if (oldest < since) return { items, complete: true };
    // `after` 不含等於的時間；加 1 避免漏掉同一毫秒的紀錄（重複者以 id 去重）。
    // 整頁都在同一毫秒時無法再往前分頁，視為未完成。
    if (after !== undefined && oldest + 1 >= after) {
      return { items, complete: false };
    }
    after = oldest + 1;
  }
}
