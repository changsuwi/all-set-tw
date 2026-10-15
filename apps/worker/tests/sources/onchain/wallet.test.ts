import { describe, expect, it } from "vitest";
import {
  RequestBudget,
  scanBackfillHistory,
  scanNewHistory,
  unitsToCoin,
  WalletApiError,
  type HistoryPage,
} from "../../../src/sources/onchain-wallet";
import type { BitcoinTransaction } from "../../../src/sources/bitcoin/client";
import { bitcoinTransfer } from "../../../src/sources/bitcoin/wallet";
import type {
  EthereumInternalTransaction,
  EthereumTransaction,
} from "../../../src/sources/ethereum/client";
import {
  ethereumInternalTransfer,
  ethereumTransfer,
} from "../../../src/sources/ethereum/wallet";

// 合成地址；格式正確但不對應真實錢包。
const COLD = "bc1qcoldwalletaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANGE = "bc1qchangeaddressaaaaaaaaaaaaaaaaaaaaaaaa";
const EXCHANGE = "3ExchangeDepositAddressAAAAAAAAAA";
const OWN_BTC = new Set([COLD, CHANGE]);

function btcTx(
  txid: string,
  vin: Array<[string, number]>,
  vout: Array<[string, number]>,
  fee: number,
): BitcoinTransaction {
  return {
    txid: txid.padEnd(64, "0"),
    fee,
    vin: vin.map(([address, value]) => ({
      prevout: { scriptpubkey_address: address, value },
    })),
    vout: vout.map(([address, value]) => ({
      scriptpubkey_address: address,
      value,
    })),
    status: {
      confirmed: true,
      block_height: 900_000,
      block_time: 1_790_000_000,
    },
  };
}

describe("bitcoin transfers", () => {
  it("counts a deposit from an exchange as a receive", () => {
    const transfer = bitcoinTransfer(
      btcTx(
        "a1",
        [[EXCHANGE, 60_000_000]],
        [
          [COLD, 50_000_000],
          [EXCHANGE, 9_990_000],
        ],
        10_000,
      ),
      OWN_BTC,
    );
    expect(transfer).toMatchObject({
      kind: "receive",
      units: 50_000_000n,
      feeUnits: 0n,
    });
  });

  it("nets change back to an own address and charges the fee to the wallet", () => {
    // 送出 0.3 BTC，找零 0.1999 BTC 回到自有找零地址，手續費 0.0001 BTC。
    const transfer = bitcoinTransfer(
      btcTx(
        "a2",
        [[COLD, 50_000_000]],
        [
          [EXCHANGE, 30_000_000],
          [CHANGE, 19_990_000],
        ],
        10_000,
      ),
      OWN_BTC,
    );
    expect(transfer).toMatchObject({
      kind: "send",
      units: -30_010_000n,
      feeUnits: 10_000n,
    });
    expect(unitsToCoin(transfer!.units, 8)).toBe(-0.3001);
  });

  it("treats a transfer between own addresses as fee only", () => {
    const transfer = bitcoinTransfer(
      btcTx("a3", [[COLD, 19_990_000]], [[CHANGE, 19_980_000]], 10_000),
      OWN_BTC,
    );
    expect(transfer).toMatchObject({ kind: "self", units: -10_000n });
  });

  it("ignores transactions that do not touch own addresses", () => {
    expect(
      bitcoinTransfer(
        btcTx("a4", [[EXCHANGE, 1]], [[EXCHANGE, 1]], 0),
        OWN_BTC,
      ),
    ).toBeNull();
  });
});

const ME = "0x1111111111111111111111111111111111111111";
const MY_OTHER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const OWN_ETH = new Set([ME, MY_OTHER]);

function ethTx(
  overrides: Omit<Partial<EthereumTransaction>, "from" | "to"> & {
    from: string;
    to: string;
  },
): EthereumTransaction {
  return {
    hash: "0xabc",
    value: "0",
    fee: { value: "21000000000000" },
    status: "ok",
    timestamp: "2026-10-01T16:30:00.000000Z",
    block_number: 20_000_000,
    ...overrides,
    from: { hash: overrides.from },
    to: { hash: overrides.to },
  };
}

describe("ethereum transfers", () => {
  it("deducts value and gas from the sender", () => {
    const transfer = ethereumTransfer(
      ethTx({ from: ME, to: OTHER, value: "1500000000000000000" }),
      OWN_ETH,
    );
    expect(transfer).toMatchObject({
      kind: "send",
      units: -1_500_021_000_000_000_000n,
      feeUnits: 21_000_000_000_000n,
    });
  });

  it("matches checksummed addresses case-insensitively", () => {
    const transfer = ethereumTransfer(
      ethTx({
        from: OTHER,
        to: ME.toUpperCase().replace("0X", "0x"),
        value: "5",
      }),
      OWN_ETH,
    );
    expect(transfer).toMatchObject({ kind: "receive", units: 5n });
  });

  it("charges only the fee when a transaction fails", () => {
    const transfer = ethereumTransfer(
      ethTx({ from: ME, to: OTHER, value: "1000", status: "error" }),
      OWN_ETH,
    );
    expect(transfer).toMatchObject({
      kind: "fee",
      units: -21_000_000_000_000n,
    });
  });

  it("keeps only the fee for transfers between own addresses", () => {
    const transfer = ethereumTransfer(
      ethTx({ from: ME, to: MY_OTHER, value: "1000" }),
      OWN_ETH,
    );
    expect(transfer).toMatchObject({
      kind: "self",
      units: -21_000_000_000_000n,
    });
  });

  it("counts contract payouts and skips the top-level call trace", () => {
    const internal = (index: number): EthereumInternalTransaction => ({
      transaction_hash: "0xdef",
      index,
      from: { hash: OTHER },
      to: { hash: ME },
      value: "2000",
      success: true,
      timestamp: "2026-10-01T00:00:00.000000Z",
      block_number: 20_000_001,
    });
    expect(ethereumInternalTransfer(internal(0), OWN_ETH)).toBeNull();
    expect(ethereumInternalTransfer(internal(3), OWN_ETH)).toMatchObject({
      sourceId: "0xdef:internal:3",
      kind: "receive",
      units: 2000n,
    });
  });

  it("converts wei without losing digits before the final number", () => {
    expect(unitsToCoin(1_234_567_890_000_000_000n, 18)).toBe(1.23456789);
    expect(unitsToCoin(-1n, 18)).toBe(-1e-18);
  });
});

describe("history scanning", () => {
  type Item = { id: string; height: number };
  // 由新到舊、每頁 2 筆的歷史。
  function pages(items: Item[]) {
    const calls: Array<string | null> = [];
    const fetchPage = async (
      next: string | null,
    ): Promise<HistoryPage<Item>> => {
      calls.push(next);
      const start = next === null ? 0 : Number(next);
      const page = items.slice(start, start + 2);
      return {
        items: page,
        next: start + 2 < items.length ? String(start + 2) : null,
      };
    };
    return { calls, fetchPage };
  }
  const height = (item: Item) => item.height;
  const history = [5, 4, 3, 2, 1].map((h) => ({ id: `t${h}`, height: h }));

  it("backfills older history across runs when the request budget runs out", async () => {
    const source = pages(history);
    const first = await scanNewHistory(
      {},
      source.fetchPage,
      height,
      new RequestBudget(2),
    );
    expect(first.items.map((item) => item.id)).toEqual([
      "t5",
      "t4",
      "t3",
      "t2",
    ]);
    expect(first.state).toEqual({
      syncedHeight: 5,
      backfillNext: "4",
      complete: false,
    });

    const newer = await scanNewHistory(
      first.state,
      source.fetchPage,
      height,
      new RequestBudget(5),
    );
    const rest = await scanBackfillHistory(
      newer.state,
      source.fetchPage,
      new RequestBudget(5),
    );
    expect(rest.items.map((item) => item.id)).toEqual(["t1"]);
    expect(rest.state).toMatchObject({
      syncedHeight: 5,
      complete: true,
      backfillNext: null,
    });
  });

  it("only fetches until it reaches the last synced block", async () => {
    const source = pages([{ id: "t6", height: 6 }, ...history]);
    const result = await scanNewHistory(
      { syncedHeight: 5, complete: true },
      source.fetchPage,
      height,
      new RequestBudget(10),
    );
    expect(source.calls).toEqual([null]);
    expect(result.state.syncedHeight).toBe(6);
  });

  it("saves progress and stops when the API rate-limits history pages", async () => {
    const source = pages(history);
    const budget = new RequestBudget(10);
    let calls = 0;
    const result = await scanNewHistory(
      {},
      async (next) => {
        calls += 1;
        if (calls === 2) throw new WalletApiError("rate limited", true);
        return source.fetchPage(next);
      },
      height,
      budget,
    );
    expect(result.items.map((item) => item.id)).toEqual(["t5", "t4"]);
    expect(result.state).toEqual({
      syncedHeight: 5,
      backfillNext: "2",
      complete: false,
    });
    expect(budget.remaining).toBe(0);
  });

  it("keeps the previous cursor when new history cannot be reached", async () => {
    const source = pages(
      [10, 9, 8, 7, 6].map((h) => ({ id: `n${h}`, height: h })).concat(history),
    );
    const state = { syncedHeight: 5, complete: true };
    const result = await scanNewHistory(
      state,
      source.fetchPage,
      height,
      new RequestBudget(1),
    );
    expect(result.state).toEqual(state);
  });
});
