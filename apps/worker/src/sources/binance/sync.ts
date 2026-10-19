import type { SyncTrigger } from "../../db";
import type { Env } from "../../platform/env";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson } from "../../platform/crypto";
import { createBinanceEgressFetcher } from "../../platform/binance-egress";
import { requireConnectorSettings } from "../../features/sync/config";
import { NeedsUserActionError } from "../../features/sync/errors";
import type { SyncEnv } from "../../features/sync/execution";
import type { SyncOutcome } from "../../features/sync/types";
import {
  aggregateHoldings,
  exchangeUsdPrice,
  type ExchangeTransfer,
} from "../exchange-account";
import {
  cryptoUsdRate,
  persistExchangeSnapshot,
} from "../exchange-account-sync";
import { EXTERNAL_REQUEST_BUDGET, RequestBudget } from "../onchain-wallet";
import { reportSyncProgress } from "../sync-progress";
import {
  BinanceApiError,
  BinanceAuthError,
  fetchDeposits,
  fetchEarnBalances,
  fetchFundingBalances,
  fetchSpotBalances,
  fetchTickerPrices,
  fetchWithdrawals,
  HISTORY_PAGE_LIMIT,
  type BinanceClientOptions,
} from "./client";
import {
  binancePair,
  depositTransfer,
  historyWindows,
  isBinanceDuplicateAsset,
  parseBinanceCursor,
  withdrawalTransfer,
  type BinanceCursor,
} from "./portfolio";
import { parseBinanceConfig } from "./protocol";

const CONNECTOR_ID = "binance";
/** 查詢結果滿額時對半切分區間的最大次數。 */
const MAX_WINDOW_SPLITS = 4;

export async function syncBinance(
  env: Env,
  trigger: SyncTrigger,
  fetcher: typeof fetch = createBinanceEgressFetcher(env.BINANCE_EGRESS),
): Promise<SyncOutcome> {
  const settings = await requireConnectorSettings(env.DB, CONNECTOR_ID);
  const config = parseBinanceConfig(
    await decryptJson<Record<string, unknown>>(
      settings.encrypted_config,
      configEncryptionKey(env),
    ),
  );
  if (!config.apiKey || !config.apiSecret) {
    throw new NeedsUserActionError(
      "請先在資料來源設定填寫幣安 API Key 與 Secret Key。",
    );
  }
  const signal = (env as SyncEnv).syncSignal;
  console.log(
    `[sync] ${CONNECTOR_ID}/all: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );
  reportSyncProgress("fetching");

  // 匯率更新保留一個對外請求，其餘給幣安 API。
  const options: BinanceClientOptions = {
    fetcher,
    credentials: { apiKey: config.apiKey, apiSecret: config.apiSecret },
    budget: new RequestBudget(EXTERNAL_REQUEST_BUDGET - 1),
    signal,
  };

  let holdings;
  let tickers;
  try {
    holdings = aggregateHoldings(
      {
        spot: await fetchSpotBalances(options),
        funding: await fetchFundingBalances(options),
        earnFlexible: await fetchEarnBalances("flexible", options),
        earnLocked: await fetchEarnBalances("locked", options),
      },
      isBinanceDuplicateAsset,
    );
    tickers = await fetchTickerPrices(options);
  } catch (error) {
    if (error instanceof BinanceAuthError) {
      throw new NeedsUserActionError(error.message);
    }
    throw error;
  }
  const usdRate = await cryptoUsdRate(env, signal);
  const history = await collectHistory(
    parseBinanceCursor(settings.sync_cursor),
    options,
  );

  return persistExchangeSnapshot(env, {
    connectorId: CONNECTOR_ID,
    brokerName: "幣安 Binance",
    priceSource: "binance",
    settings,
    holdings,
    priceOf: (asset) => exchangeUsdPrice(asset, tickers, binancePair),
    usdRate,
    transfers: history.transfers,
    cursor: history.cursor,
    requestsLeft: options.budget.remaining,
  });
}

/**
 * 由舊到新查詢入出金。額度用完或暫時性錯誤時停止，cursor 只前進到已完整
 * 查詢的區間，下次同步接續；餘額已取得，因此不影響本次持倉寫入。
 */
async function collectHistory(
  cursor: BinanceCursor,
  options: BinanceClientOptions,
): Promise<{ transfers: ExchangeTransfer[]; cursor: BinanceCursor }> {
  const transfers = new Map<string, ExchangeTransfer>();
  let syncedUntil = cursor.historySyncedUntil;
  try {
    for (const window of historyWindows(cursor, Date.now())) {
      for (const transfer of await fetchWindow(
        window.start,
        window.end,
        options,
      )) {
        transfers.set(transfer.sourceId, transfer);
      }
      syncedUntil = window.end;
    }
  } catch (error) {
    if (!(error instanceof BinanceApiError && error.retryable)) throw error;
    console.warn(`[sync] ${CONNECTOR_ID} history paused: ${error.message}`);
  }
  return {
    transfers: [...transfers.values()],
    cursor: { version: 1, historySyncedUntil: syncedUntil },
  };
}

async function fetchWindow(
  start: number,
  end: number,
  options: BinanceClientOptions,
  depth = 0,
): Promise<ExchangeTransfer[]> {
  const deposits = await fetchDeposits(start, end, options);
  const withdrawals = await fetchWithdrawals(start, end, options);
  if (
    deposits.length >= HISTORY_PAGE_LIMIT ||
    withdrawals.length >= HISTORY_PAGE_LIMIT
  ) {
    if (depth >= MAX_WINDOW_SPLITS) {
      throw new BinanceApiError("幣安入出金紀錄過多，無法完整同步。");
    }
    const middle = start + Math.floor((end - start) / 2);
    return [
      ...(await fetchWindow(start, middle, options, depth + 1)),
      ...(await fetchWindow(middle + 1, end, options, depth + 1)),
    ];
  }
  return [
    ...deposits.map(depositTransfer),
    ...withdrawals.map(withdrawalTransfer),
  ].filter((transfer): transfer is ExchangeTransfer => transfer !== null);
}
