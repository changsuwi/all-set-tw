import type { SyncTrigger } from "../db";
import type { Env } from "../platform/env";
import { configEncryptionKey } from "../platform/config";
import { decryptJson } from "../platform/crypto";
import { requireConnectorSettings } from "../features/sync/config";
import { connectorStateStatement } from "../features/sync/connector-repository";
import { NeedsUserActionError } from "../features/sync/errors";
import type { SyncEnv } from "../features/sync/execution";
import { persistStagedSyncWrite } from "../features/sync/persistence";
import {
  investmentPositionRecord,
  investmentTransactionRecord,
  netWorthHistoryRecord,
} from "../features/sync/record-mapper";
import type { SyncOutcome } from "../features/sync/types";
import { fetchCryptoTwdPrices } from "./crypto-price";
import {
  EXTERNAL_REQUEST_BUDGET,
  maskAddress,
  parseWalletCursor,
  REQUEST_PACE_MS,
  RequestBudget,
  taipeiDate,
  TRANSFER_LABELS,
  unitsToCoin,
  type OnchainConnectorId,
  type WalletCollection,
  type WalletCursor,
} from "./onchain-wallet";
import { reportSyncProgress } from "./sync-progress";

/**
 * BTC／ETH 鏈上錢包共用的同步協調：讀取地址設定、在固定的對外請求額度內
 * 取得餘額與交易歷史、以 MAX 台幣報價估值，最後寫入投資持倉、交易與淨值歷史。
 * 各鏈只負責地址驗證、區塊鏈 API 與單筆交易的淨變化計算。
 */
export type OnchainWalletSpec = {
  connectorId: OnchainConnectorId;
  symbol: "BTC" | "ETH";
  name: string;
  decimals: number;
  parseAddresses: (config: Record<string, unknown>) => string[];
  collect: (input: {
    addresses: string[];
    cursor: WalletCursor;
    budget: RequestBudget;
    signal?: AbortSignal;
  }) => Promise<WalletCollection>;
};

export async function syncOnchainWallet(
  env: Env,
  trigger: SyncTrigger,
  spec: OnchainWalletSpec,
): Promise<SyncOutcome> {
  const { connectorId, symbol } = spec;
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const addresses = spec.parseAddresses(stored);
  if (addresses.length === 0) {
    throw new NeedsUserActionError("請先在資料來源設定填寫錢包地址。");
  }
  const signal = (env as SyncEnv).syncSignal;

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} addresses=${addresses.length} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );
  reportSyncProgress("fetching");

  const prices = await fetchCryptoTwdPrices([symbol], { signal });
  const price = prices[symbol]!;
  const budget = new RequestBudget(
    EXTERNAL_REQUEST_BUDGET - 1,
    REQUEST_PACE_MS,
  );
  const collection = await spec.collect({
    addresses,
    cursor: parseWalletCursor(settings.sync_cursor),
    budget,
    signal,
  });

  const now = new Date().toISOString();
  const asOfDate = taipeiDate(now);
  const totalUnits = collection.balances.reduce(
    (sum, balance) => sum + balance.units,
    0n,
  );
  const quantity = unitsToCoin(totalUnits, spec.decimals);
  const marketValue = Math.round(quantity * price.priceTwd);
  const accountId = "wallet";

  const records = [
    investmentPositionRecord(
      connectorId,
      {
        sourceId: symbol.toLowerCase(),
        assetType: "crypto",
        symbol,
        name: spec.name,
        quantity,
        marketValue,
        currency: "TWD",
        asOfDate,
        raw: {
          priceTwd: price.priceTwd,
          priceAt: price.at,
          priceSource: price.source,
          addresses: collection.balances.map((balance) => ({
            address: maskAddress(balance.address),
            quantity: unitsToCoin(balance.units, spec.decimals),
          })),
        },
      },
      now,
    ),
    ...collection.transfers.map((transfer) =>
      investmentTransactionRecord(
        connectorId,
        {
          accountId,
          sourceId: transfer.sourceId,
          brokerName: spec.name,
          symbol,
          name: spec.name,
          assetType: "crypto",
          tradeDate: taipeiDate(transfer.occurredAt),
          postedDate: taipeiDate(transfer.occurredAt),
          transactionCode: transfer.kind,
          transactionName: TRANSFER_LABELS[transfer.kind],
          quantity: unitsToCoin(transfer.units, spec.decimals),
          currency: "TWD",
          raw: {
            ...transfer.raw,
            occurredAt: transfer.occurredAt,
            fee: unitsToCoin(transfer.feeUnits, spec.decimals),
          },
        },
        now,
      ),
    ),
    netWorthHistoryRecord(
      connectorId,
      { date: asOfDate, netWorth: marketValue, assetType: "crypto" },
      now,
    ),
  ];

  console.log(
    `[sync] ${connectorId}/${scope}: quantity=${quantity} transfers=${collection.transfers.length} requestsLeft=${budget.remaining}`,
  );

  const cursor = JSON.stringify(collection.cursor);
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    // 同步期間若地址設定已變更，舊地址的結果不得寫入。
    settingsGuard: { connectorId, encryptedConfig: settings.encrypted_config },
    finalizeStatements: [
      connectorStateStatement(
        env.DB,
        connectorId,
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
    connectorId,
    scope,
    records: records.length,
    newRecords,
    cursorUpdated: cursor !== settings.sync_cursor,
  };
}
