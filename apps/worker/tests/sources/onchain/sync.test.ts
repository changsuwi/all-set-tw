import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";
import { createTestD1, readMigrations } from "../../helpers/d1";
import { encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import { syncBitcoin } from "../../../src/sources/bitcoin/sync";
import { syncEthereum } from "../../../src/sources/ethereum/sync";
import { updateConnectorSettings } from "../../../src/features/connectors/service";

const key = "synthetic-test-encryption-key";
const NOW = "2026-10-15T04:00:00.000Z";
// 合成地址；符合格式但不對應真實錢包。
const COLD = `bc1q${"a".repeat(38)}`;
const EXCHANGE = "3ExchangeDepositAddressAAAAAAAAAA";
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x3333333333333333333333333333333333333333";

let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function maxTickers(url: URL) {
  const markets = url.searchParams.getAll("markets[]");
  const prices: Record<string, string> = {
    btctwd: "2000000.0",
    ethtwd: "80000.0",
  };
  return json(
    markets.map((market) => ({
      market,
      at: 1_792_000_000,
      last: prices[market],
    })),
  );
}

async function configure(
  connectorId: "bitcoin" | "ethereum",
  addresses: string,
) {
  await env.DB.prepare(
    "INSERT INTO connector_settings(id, connector_id, encrypted_config, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
  )
    .bind(
      connectorId,
      connectorId,
      await encryptJson({ addresses }, key),
      NOW,
      NOW,
    )
    .run();
}

async function rows(sql: string) {
  return (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;
}

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  harness = await createTestD1();
  env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as unknown as Env;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await harness.mf.dispose();
});

describe("bitcoin wallet sync", () => {
  const history = [
    {
      txid: "b".repeat(64),
      fee: 10_000,
      vin: [{ prevout: { scriptpubkey_address: COLD, value: 50_000_000 } }],
      vout: [
        { scriptpubkey_address: EXCHANGE, value: 10_000_000 },
        { scriptpubkey_address: COLD, value: 39_990_000 },
      ],
      status: {
        confirmed: true,
        block_height: 900_010,
        block_time: 1_791_000_000,
      },
    },
    {
      txid: "a".repeat(64),
      fee: 2_000,
      vin: [{ prevout: { scriptpubkey_address: EXCHANGE, value: 60_000_000 } }],
      vout: [{ scriptpubkey_address: COLD, value: 50_000_000 }],
      status: {
        confirmed: true,
        block_height: 900_000,
        block_time: 1_790_000_000,
      },
    },
  ];

  it("writes the TWD position, transfers and net worth without duplicating on resync", async () => {
    await configure("bitcoin", `${COLD}\n`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "max-api.maicoin.com") return maxTickers(url);
      if (url.pathname.endsWith("/txs/chain")) return json(history);
      if (url.pathname === `/api/address/${COLD}`) {
        return json({
          chain_stats: {
            funded_txo_sum: 89_990_000,
            spent_txo_sum: 50_000_000,
          },
        });
      }
      return json({ error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await syncBitcoin(env, "manual");
    await syncBitcoin(env, "manual");

    expect(first.newRecords.investmentTransactions).toBe(2);
    expect(
      await rows(
        "SELECT asset_type, symbol, quantity, market_value, currency, as_of_date FROM investment_positions WHERE connector_id = 'bitcoin'",
      ),
    ).toEqual([
      {
        asset_type: "crypto",
        symbol: "BTC",
        quantity: 0.3999,
        market_value: 799_800,
        currency: "TWD",
        as_of_date: "2026-10-15",
      },
    ]);
    expect(
      await rows(
        "SELECT source_id, transaction_code, quantity, trade_date FROM investment_transactions WHERE connector_id = 'bitcoin' ORDER BY source_id",
      ),
    ).toEqual([
      {
        source_id: "a".repeat(64),
        transaction_code: "receive",
        quantity: 0.5,
        trade_date: "2026-09-21",
      },
      {
        source_id: "b".repeat(64),
        transaction_code: "send",
        quantity: -0.1001,
        trade_date: "2026-10-03",
      },
    ]);
    expect(
      await rows(
        "SELECT asset_type, source, net_worth FROM net_worth_history WHERE source = 'bitcoin'",
      ),
    ).toEqual([
      { asset_type: "crypto", source: "bitcoin", net_worth: 799_800 },
    ]);

    // 第二次同步已知道上次處理到的區塊，只取最新一頁。
    const historyCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/txs/chain"),
    );
    expect(historyCalls).toHaveLength(2);
    const cursor = await env.DB.prepare(
      "SELECT sync_cursor FROM connector_settings WHERE connector_id = 'bitcoin'",
    ).first<{ sync_cursor: string }>();
    expect(cursor?.sync_cursor).not.toContain(COLD);
  });

  it("rejects extended public keys with a clear message", async () => {
    await configure("bitcoin", COLD);
    await expect(
      updateConnectorSettings(env, "bitcoin", {
        addresses: "zpub6rFR7y4Q2Aij",
      }),
    ).rejects.toThrow("尚不支援 xpub");
  });
});

describe("ethereum wallet sync", () => {
  it("values the wallet in TWD and records gas on outgoing transfers", async () => {
    await configure("ethereum", ME.toUpperCase().replace("0X", "0x"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.hostname === "max-api.maicoin.com") return maxTickers(url);
        if (url.pathname === `/api/v2/addresses/${ME}`) {
          return json({ coin_balance: "1250000000000000000" });
        }
        if (url.pathname.endsWith("/internal-transactions")) {
          return json({ items: [], next_page_params: null });
        }
        if (url.pathname.endsWith("/transactions")) {
          return json({
            items: [
              {
                hash: "0xsend",
                from: { hash: ME },
                to: { hash: OTHER },
                value: "500000000000000000",
                fee: { value: "100000000000000" },
                status: "ok",
                timestamp: "2026-10-10T01:00:00.000000Z",
                block_number: 20_000_010,
              },
              {
                hash: "0xpending",
                from: { hash: OTHER },
                to: { hash: ME },
                value: "1",
                fee: null,
                status: null,
                timestamp: null,
                block_number: null,
              },
            ],
            next_page_params: null,
          });
        }
        return json({ error: "unexpected" }, 404);
      }),
    );

    await syncEthereum(env, "scheduled");

    expect(
      await rows(
        "SELECT quantity, market_value FROM investment_positions WHERE connector_id = 'ethereum'",
      ),
    ).toEqual([{ quantity: 1.25, market_value: 100_000 }]);
    expect(
      await rows(
        "SELECT source_id, transaction_name, quantity FROM investment_transactions WHERE connector_id = 'ethereum'",
      ),
    ).toEqual([
      { source_id: "0xsend", transaction_name: "轉出", quantity: -0.5001 },
    ]);
  });
});

describe("crypto asset type migration", () => {
  it("keeps existing investment rows when rebuilding the tables", async () => {
    const migrations = readMigrations();
    const index = migrations.findIndex(
      (sql) =>
        sql.includes("investment_positions_new") && sql.includes("'crypto'"),
    );
    const before = await createTestD1(undefined, migrations.slice(0, index));
    try {
      const db = before.binding;
      await db.batch([
        db
          .prepare(
            "INSERT INTO investment_positions (id, connector_id, source_id, asset_type, symbol, name, quantity, market_value, currency, as_of_date, created_at, updated_at) VALUES ('p1', 'tdcc', '2330', 'stock', '2330', '台積電', 10, 12000, 'TWD', '2026-10-01', ?1, ?1)",
          )
          .bind(NOW),
        db
          .prepare(
            "INSERT INTO investment_transactions (id, connector_id, account_id, source_id, asset_type, trade_date, quantity, amount, currency, created_at, updated_at) VALUES ('t1', 'tdcc', 'acct', 's1', 'stock', '2026-09-30', 10, -12000, 'TWD', ?1, ?1)",
          )
          .bind(NOW),
      ]);
      const statements = unstable_splitSqlQuery(migrations[index]!)
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => db.prepare(statement));
      await db.batch(statements);

      expect(
        await db
          .prepare("SELECT id, name, market_value FROM investment_positions")
          .all(),
      ).toMatchObject({
        results: [{ id: "p1", name: "台積電", market_value: 12000 }],
      });
      expect(
        await db
          .prepare(
            "SELECT id, amount, effective_date FROM investment_transactions",
          )
          .all(),
      ).toMatchObject({
        results: [{ id: "t1", amount: -12000, effective_date: "2026-09-30" }],
      });
    } finally {
      await before.mf.dispose();
    }
  });
});
