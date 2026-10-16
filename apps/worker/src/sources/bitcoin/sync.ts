import type { SyncTrigger } from "../../db";
import type { Env } from "../../platform/env";
import {
  addressKey,
  RequestBudget,
  scanBackfillHistory,
  scanNewHistory,
  WalletApiError,
  type HistoryCursor,
  type WalletCollection,
  type WalletCursor,
  type WalletTransfer,
} from "../onchain-wallet";
import { syncOnchainWallet } from "../onchain-wallet-sync";
import {
  fetchBitcoinBalance,
  fetchBitcoinTransactionPage,
  fetchBitcoinUsdPrice,
  type BitcoinTransaction,
} from "./client";
import { parseBitcoinAddresses, parseBitcoinConfig } from "./protocol";
import { bitcoinTransfer } from "./wallet";

export function syncBitcoin(env: Env, trigger: SyncTrigger) {
  return syncOnchainWallet(env, trigger, {
    connectorId: "bitcoin",
    symbol: "BTC",
    name: "Bitcoin",
    decimals: 8,
    parseAddresses: (config) =>
      parseBitcoinAddresses(parseBitcoinConfig(config).addresses),
    fetchUsdPrice: fetchBitcoinUsdPrice,
    collect: collectBitcoinWallet,
  });
}

export async function collectBitcoinWallet({
  addresses,
  cursor,
  budget,
  signal,
  fetcher,
}: {
  addresses: string[];
  cursor: WalletCursor;
  budget: RequestBudget;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<WalletCollection> {
  const options = { signal, fetcher };
  const ownAddresses = new Set(addresses);
  const keys = await Promise.all(addresses.map(addressKey));
  const states = keys.map(
    (key): HistoryCursor => cursor.addresses[key]?.txs ?? {},
  );

  // 餘額優先：地址上限確保額度一定足夠，歷史紀錄則可分次補齊。
  const balances = [];
  for (const address of addresses) {
    if (!(await budget.take())) {
      throw new WalletApiError("BTC 地址過多，無法在單次同步內查詢完畢。");
    }
    balances.push({
      address,
      units: await fetchBitcoinBalance(address, options),
    });
  }

  const transactions = new Map<string, BitcoinTransaction>();
  const collect = (items: BitcoinTransaction[]) => {
    for (const item of items) transactions.set(item.txid, item);
  };
  const heightOf = (item: BitcoinTransaction) => item.status.block_height ?? 0;

  for (const [index, address] of addresses.entries()) {
    const result = await scanNewHistory(
      states[index]!,
      (next) => fetchBitcoinTransactionPage(address, next, options),
      heightOf,
      budget,
    );
    collect(result.items);
    states[index] = result.state;
  }
  for (const [index, address] of addresses.entries()) {
    const result = await scanBackfillHistory(
      states[index]!,
      (next) => fetchBitcoinTransactionPage(address, next, options),
      budget,
    );
    collect(result.items);
    states[index] = result.state;
  }

  return {
    balances,
    transfers: [...transactions.values()]
      .map((transaction) => bitcoinTransfer(transaction, ownAddresses))
      .filter((transfer): transfer is WalletTransfer => transfer !== null),
    cursor: {
      version: 1,
      addresses: Object.fromEntries(
        keys.map((key, index) => [key, { txs: states[index]! }]),
      ),
    },
  };
}
