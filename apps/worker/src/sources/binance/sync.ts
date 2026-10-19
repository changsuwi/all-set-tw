import type { SyncTrigger } from "../../db";
import type { Env } from "../../platform/env";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson } from "../../platform/crypto";
import { createBinanceEgressFetcher } from "../../platform/binance-egress";
import { requireConnectorSettings } from "../../features/sync/config";
import { connectorStateStatement } from "../../features/sync/connector-repository";
import { NeedsUserActionError } from "../../features/sync/errors";
import type { SyncEnv } from "../../features/sync/execution";
import { persistStagedSyncWrite } from "../../features/sync/persistence";
import {
  investmentPositionRecord,
  investmentTransactionRecord,
  netWorthHistoryRecord,
} from "../../features/sync/record-mapper";
import type { SyncOutcome } from "../../features/sync/types";
import { getRateToTwd } from "../../features/exchange-rates/service";
import { CryptoPriceUnavailableError } from "../crypto-price";
import {
  EXTERNAL_REQUEST_BUDGET,
  RequestBudget,
  taipeiDate,
} from "../onchain-wallet";
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
  aggregateHoldings,
  binanceUsdPrice,
  depositTransfer,
  historyWindows,
  parseBinanceCursor,
  withdrawalTransfer,
  type BinanceCursor,
  type BinanceTransfer,
} from "./portfolio";
import { parseBinanceConfig } from "./protocol";

const CONNECTOR_ID = "binance";
const ACCOUNT_ID = "exchange";
const BROKER_NAME = "幣安 Binance";
/** 查詢結果滿額時對半切分區間的最大次數。 */
const MAX_WINDOW_SPLITS = 4;

const TRANSFER_LABELS = { deposit: "入金", withdraw: "提領" } as const;

export async function syncBinance(
  env: Env,
  trigger: SyncTrigger,
  fetcher: typeof fetch = createBinanceEgressFetcher(env.BINANCE_EGRESS),
): Promise<SyncOutcome> {
  const scope = "all";
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
    `[sync] ${CONNECTOR_ID}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
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
    holdings = aggregateHoldings({
      spot: await fetchSpotBalances(options),
      funding: await fetchFundingBalances(options),
      earnFlexible: await fetchEarnBalances("flexible", options),
      earnLocked: await fetchEarnBalances("locked", options),
    });
    tickers = await fetchTickerPrices(options);
  } catch (error) {
    if (error instanceof BinanceAuthError) {
      throw new NeedsUserActionError(error.message);
    }
    throw error;
  }
  const usdRate = await getRateToTwd(env.DB, "USD").catch(() => {
    signal?.throwIfAborted();
    throw new CryptoPriceUnavailableError(
      "美元匯率暫時無法取得，無法換算加密貨幣的新台幣價值，請稍後再試。",
    );
  });

  const previousCursor = parseBinanceCursor(settings.sync_cursor);
  const history = await collectHistory(previousCursor, options);

  const now = new Date().toISOString();
  const asOfDate = taipeiDate(now);
  const unpriced: string[] = [];
  const positions = [];
  for (const holding of holdings) {
    const price = binanceUsdPrice(holding.asset, tickers);
    if (!price) {
      unpriced.push(holding.asset);
      continue;
    }
    const marketValue = Math.round(
      holding.quantity * price.priceUsd * usdRate.rateTwd,
    );
    // 不足 1 元的零碎資產不列入。
    if (marketValue < 1) continue;
    positions.push({ holding, price, marketValue });
  }
  if (unpriced.length > 0) {
    console.warn(
      `[sync] ${CONNECTOR_ID}/${scope}: no USD price for ${unpriced.join(",")}`,
    );
  }
  const totalValue = positions.reduce(
    (sum, { marketValue }) => sum + marketValue,
    0,
  );

  const records = [
    ...positions.map(({ holding, price, marketValue }) =>
      investmentPositionRecord(
        CONNECTOR_ID,
        {
          sourceId: holding.asset.toLowerCase(),
          assetType: "crypto",
          symbol: holding.asset,
          name: holding.asset,
          quantity: holding.quantity,
          marketValue,
          currency: "TWD",
          asOfDate,
          raw: {
            wallets: holding.wallets,
            priceUsd: price.priceUsd,
            pricePair: price.pair,
            priceTwd: price.priceUsd * usdRate.rateTwd,
            usdRateToTwd: usdRate.rateTwd,
            usdRateUpdatedAt: usdRate.updatedAt,
            priceSource: "binance",
          },
        },
        now,
      ),
    ),
    ...history.transfers.map((transfer) =>
      investmentTransactionRecord(
        CONNECTOR_ID,
        {
          accountId: ACCOUNT_ID,
          sourceId: transfer.sourceId,
          brokerName: BROKER_NAME,
          symbol: transfer.asset,
          name: transfer.asset,
          assetType: "crypto",
          tradeDate: taipeiDate(transfer.occurredAt),
          postedDate: taipeiDate(transfer.occurredAt),
          transactionCode: transfer.kind,
          transactionName: TRANSFER_LABELS[transfer.kind],
          quantity: transfer.quantity,
          currency: "TWD",
          raw: { ...transfer.raw, occurredAt: transfer.occurredAt },
        },
        now,
      ),
    ),
    netWorthHistoryRecord(
      CONNECTOR_ID,
      { date: asOfDate, netWorth: totalValue, assetType: "crypto" },
      now,
    ),
  ];

  console.log(
    `[sync] ${CONNECTOR_ID}/${scope}: positions=${positions.length} transfers=${history.transfers.length} requestsLeft=${options.budget.remaining}`,
  );

  const cursor = JSON.stringify(history.cursor);
  const settingsGuard = {
    connectorId: CONNECTOR_ID,
    encryptedConfig: settings.encrypted_config,
  } as const;
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    // 同步期間若 API key 已變更，舊 key 的結果不得寫入。
    settingsGuard,
    // 當天稍早同步、之後已賣出或轉走的幣別不得留在今天的持倉。
    beforePromoteStatements: [
      env.DB.prepare(
        `DELETE FROM investment_positions
         WHERE connector_id = ? AND as_of_date = ?
           AND source_id NOT IN (SELECT value FROM json_each(?))
           AND EXISTS (
             SELECT 1 FROM connector_settings
             WHERE connector_id = ? AND encrypted_config = ?
           )`,
      ).bind(
        CONNECTOR_ID,
        asOfDate,
        JSON.stringify(
          positions.map(({ holding }) => holding.asset.toLowerCase()),
        ),
        settingsGuard.connectorId,
        settingsGuard.encryptedConfig,
      ),
    ],
    finalizeStatements: [
      connectorStateStatement(
        env.DB,
        CONNECTOR_ID,
        settings.encrypted_config,
        settings.public_config,
        cursor,
        now,
        settings.encrypted_config,
      ),
    ],
  });

  return {
    success: true,
    connectorId: CONNECTOR_ID,
    scope,
    records: records.length,
    newRecords,
    cursorUpdated: cursor !== settings.sync_cursor,
  };
}

/**
 * 由舊到新查詢入出金。額度用完或暫時性錯誤時停止，cursor 只前進到已完整
 * 查詢的區間，下次同步接續；餘額已取得，因此不影響本次持倉寫入。
 */
async function collectHistory(
  cursor: BinanceCursor,
  options: BinanceClientOptions,
): Promise<{ transfers: BinanceTransfer[]; cursor: BinanceCursor }> {
  const transfers = new Map<string, BinanceTransfer>();
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
): Promise<BinanceTransfer[]> {
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
  ].filter((transfer): transfer is BinanceTransfer => transfer !== null);
}
