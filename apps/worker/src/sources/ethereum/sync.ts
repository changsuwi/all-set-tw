import type { SyncTrigger } from "../../db";
import type { Env } from "../../platform/env";
import {
  addressKey,
  RequestBudget,
  scanBackfillHistory,
  scanNewHistory,
  WalletApiError,
  type HistoryCursor,
  type HistoryPage,
  type WalletCollection,
  type WalletCursor,
  type WalletTransfer,
} from "../onchain-wallet";
import { syncOnchainWallet } from "../onchain-wallet-sync";
import {
  fetchEthereumBalance,
  fetchEthereumInternalTransactionPage,
  fetchEthereumTransactionPage,
  fetchEthereumUsdPrice,
  type EthereumInternalTransaction,
  type EthereumTransaction,
} from "./client";
import { parseEthereumAddresses, parseEthereumConfig } from "./protocol";
import { ethereumInternalTransfer, ethereumTransfer } from "./wallet";

export function syncEthereum(env: Env, trigger: SyncTrigger) {
  return syncOnchainWallet(env, trigger, {
    connectorId: "ethereum",
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    parseAddresses: (config) =>
      parseEthereumAddresses(parseEthereumConfig(config).addresses),
    fetchUsdPrice: fetchEthereumUsdPrice,
    collect: collectEthereumWallet,
  });
}

type HistoryList = {
  name: "txs" | "internal";
  fetchPage: (
    address: string,
    next: string | null,
  ) => Promise<HistoryPage<EthereumTransaction | EthereumInternalTransaction>>;
};

export async function collectEthereumWallet({
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
  const lists: HistoryList[] = [
    {
      name: "txs",
      fetchPage: (address, next) =>
        fetchEthereumTransactionPage(address, next, options),
    },
    {
      name: "internal",
      fetchPage: (address, next) =>
        fetchEthereumInternalTransactionPage(address, next, options),
    },
  ];
  const states = keys.map((key) =>
    Object.fromEntries(
      lists.map((list): [string, HistoryCursor] => [
        list.name,
        cursor.addresses[key]?.[list.name] ?? {},
      ]),
    ),
  );

  // 餘額優先：地址上限確保額度一定足夠，歷史紀錄則可分次補齊。
  const balances = [];
  for (const address of addresses) {
    if (!(await budget.take())) {
      throw new WalletApiError("ETH 地址過多，無法在單次同步內查詢完畢。");
    }
    balances.push({
      address,
      units: await fetchEthereumBalance(address, options),
    });
  }

  const transfers = new Map<string, WalletTransfer>();
  const collect = (
    items: Array<EthereumTransaction | EthereumInternalTransaction>,
  ) => {
    for (const item of items) {
      const transfer =
        "hash" in item
          ? ethereumTransfer(item, ownAddresses)
          : ethereumInternalTransfer(item, ownAddresses);
      if (transfer) transfers.set(transfer.sourceId, transfer);
    }
  };
  const heightOf = (item: { block_number?: number | null }) =>
    item.block_number ?? 0;

  for (const [index, address] of addresses.entries()) {
    for (const list of lists) {
      const result = await scanNewHistory(
        states[index]![list.name]!,
        (next) => list.fetchPage(address, next),
        heightOf,
        budget,
      );
      collect(result.items);
      states[index]![list.name] = result.state;
    }
  }
  for (const [index, address] of addresses.entries()) {
    for (const list of lists) {
      const result = await scanBackfillHistory(
        states[index]![list.name]!,
        (next) => list.fetchPage(address, next),
        budget,
      );
      collect(result.items);
      states[index]![list.name] = result.state;
    }
  }

  return {
    balances,
    transfers: [...transfers.values()],
    cursor: {
      version: 1,
      addresses: Object.fromEntries(
        keys.map((key, index) => [key, states[index]!]),
      ),
    },
  };
}
