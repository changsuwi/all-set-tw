import type { Env } from "../platform/env";
import type { requireConnectorSettings } from "../features/sync/config";
import { connectorStateStatement } from "../features/sync/connector-repository";
import { persistStagedSyncWrite } from "../features/sync/persistence";
import {
  investmentPositionRecord,
  investmentTransactionRecord,
  netWorthHistoryRecord,
} from "../features/sync/record-mapper";
import type { SyncOutcome } from "../features/sync/types";
import { getRateToTwd } from "../features/exchange-rates/service";
import { CryptoPriceUnavailableError } from "./crypto-price";
import { taipeiDate } from "./onchain-wallet";
import type {
  ExchangeConnectorId,
  ExchangeHolding,
  ExchangeTransfer,
  ExchangeUsdPrice,
} from "./exchange-account";

type ConnectorSettingsRow = Awaited<
  ReturnType<typeof requireConnectorSettings>
>;

const SCOPE = "all";
const ACCOUNT_ID = "exchange";
const TRANSFER_LABELS = { deposit: "入金", withdraw: "提領" } as const;

/** 加密貨幣估值使用的美元匯率；取不到時整次同步失敗，不寫入 0 元持倉。 */
export function cryptoUsdRate(env: Env, signal?: AbortSignal) {
  return getRateToTwd(env.DB, "USD").catch(() => {
    signal?.throwIfAborted();
    throw new CryptoPriceUnavailableError(
      "美元匯率暫時無法取得，無法換算加密貨幣的新台幣價值，請稍後再試。",
    );
  });
}

/**
 * 寫入交易所帳戶快照：每個可估值幣別一筆持倉、入出金交易與當天淨值。
 * 無法估價的幣別只記 log；台幣價值不足 1 元的零碎資產不列入。
 */
export async function persistExchangeSnapshot(
  env: Env,
  input: {
    connectorId: ExchangeConnectorId;
    brokerName: string;
    priceSource: string;
    settings: ConnectorSettingsRow;
    holdings: ExchangeHolding[];
    priceOf: (asset: string) => ExchangeUsdPrice | undefined;
    usdRate: { rateTwd: number; updatedAt: string };
    transfers: ExchangeTransfer[];
    cursor: unknown;
    requestsLeft: number;
  },
): Promise<SyncOutcome> {
  const { connectorId, settings, usdRate } = input;
  const now = new Date().toISOString();
  const asOfDate = taipeiDate(now);
  const unpriced: string[] = [];
  const positions = [];
  for (const holding of input.holdings) {
    const price = input.priceOf(holding.asset);
    if (!price) {
      unpriced.push(holding.asset);
      continue;
    }
    const marketValue = Math.round(
      holding.quantity * price.priceUsd * usdRate.rateTwd,
    );
    if (marketValue < 1) continue;
    positions.push({ holding, price, marketValue });
  }
  if (unpriced.length > 0) {
    console.warn(
      `[sync] ${connectorId}/${SCOPE}: no USD price for ${unpriced.join(",")}`,
    );
  }
  const totalValue = positions.reduce(
    (sum, { marketValue }) => sum + marketValue,
    0,
  );

  const records = [
    ...positions.map(({ holding, price, marketValue }) =>
      investmentPositionRecord(
        connectorId,
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
            priceSource: input.priceSource,
          },
        },
        now,
      ),
    ),
    ...input.transfers.map((transfer) =>
      investmentTransactionRecord(
        connectorId,
        {
          accountId: ACCOUNT_ID,
          sourceId: transfer.sourceId,
          brokerName: input.brokerName,
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
      connectorId,
      { date: asOfDate, netWorth: totalValue, assetType: "crypto" },
      now,
    ),
  ];

  console.log(
    `[sync] ${connectorId}/${SCOPE}: positions=${positions.length} transfers=${input.transfers.length} requestsLeft=${input.requestsLeft}`,
  );

  const cursor = JSON.stringify(input.cursor);
  const settingsGuard = {
    connectorId,
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
        connectorId,
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
    scope: SCOPE,
    records: records.length,
    newRecords,
    cursorUpdated: cursor !== settings.sync_cursor,
  };
}
