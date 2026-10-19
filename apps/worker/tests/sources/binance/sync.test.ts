import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import {
  createBinanceEgressFetcher,
  proxyBinanceEgress,
} from "../../../src/platform/binance-egress";
import { syncBinance } from "../../../src/sources/binance/sync";
import { NeedsUserActionError } from "../../../src/features/sync/errors";

const key = "synthetic-test-encryption-key";
const NOW = "2026-10-15T04:00:00.000Z";
// 合成 key；格式符合幣安 HMAC key，但不對應真實帳號。
const API_KEY = "A".repeat(64);
const API_SECRET = "s".repeat(64);
// 1 USD = 32 TWD。
const USD_RATE_TO_TWD = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function rows(sql: string) {
  return (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;
}

type Account = {
  spot: Array<{ asset: string; free: string; locked: string }>;
  funding: Array<{ asset: string; free: string }>;
  flexible: Array<{ asset: string; totalAmount: string }>;
  locked: Array<{ asset: string; amount: string }>;
};

const tickers = [
  { symbol: "BTCUSDT", price: "60000.00" },
  { symbol: "ETHUSDT", price: "2500.00" },
  { symbol: "USDCUSDT", price: "1.0000" },
  // 只有 BTC 交易對的幣經 BTCUSDT 交叉換算。
  { symbol: "XYZBTC", price: "0.00010000" },
];

const deposits = [
  {
    id: "dep-1",
    amount: "0.50000000",
    coin: "BTC",
    network: "BTC",
    status: 1,
    txId: "a".repeat(64),
    insertTime: Date.parse("2026-10-01T02:00:00Z"),
  },
  // 處理中的入金不列入。
  {
    id: "dep-2",
    amount: "9.00000000",
    coin: "ETH",
    network: "ETH",
    status: 0,
    txId: "b".repeat(64),
    insertTime: Date.parse("2026-10-14T02:00:00Z"),
  },
];

const withdrawals = [
  {
    id: "wd-1",
    amount: "1.00000000",
    transactionFee: "0.00100000",
    coin: "ETH",
    network: "ETH",
    status: 6,
    txId: "0xabc",
    address: "0x1111111111111111111111111111111111111111",
    applyTime: "2026-10-10 15:30:00",
  },
];

function binanceMock(account: Account) {
  const calls: URL[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === "/api/v3/ticker/price") return json(tickers);
      const headers = new Headers(init?.headers);
      // 驗證簽章：以獨立實作計算 signature 前的 query 字串。
      const signature = url.searchParams.get("signature");
      const unsigned = url.search.slice(1).replace(/&signature=[0-9a-f]+$/, "");
      if (
        headers.get("X-MBX-APIKEY") !== API_KEY ||
        signature !==
          createHmac("sha256", API_SECRET).update(unsigned).digest("hex")
      ) {
        return json(
          { code: -1022, msg: "Signature for this request is not valid." },
          400,
        );
      }
      switch (url.pathname) {
        case "/api/v3/account":
          return json({ balances: account.spot });
        case "/sapi/v1/asset/get-funding-asset":
          return json(
            account.funding.map((balance) => ({
              ...balance,
              locked: "0",
              freeze: "0",
              withdrawing: "0",
            })),
          );
        case "/sapi/v1/simple-earn/flexible/position":
          return json({
            rows: account.flexible,
            total: account.flexible.length,
          });
        case "/sapi/v1/simple-earn/locked/position":
          return json({ rows: account.locked, total: account.locked.length });
        case "/sapi/v1/capital/deposit/hisrec":
          return json(
            deposits.filter(
              ({ insertTime }) =>
                insertTime >= Number(url.searchParams.get("startTime")) &&
                insertTime <= Number(url.searchParams.get("endTime")),
            ),
          );
        case "/sapi/v1/capital/withdraw/history":
          return json(
            withdrawals.filter(({ applyTime }) => {
              const at = Date.parse(`${applyTime.replace(" ", "T")}Z`);
              return (
                at >= Number(url.searchParams.get("startTime")) &&
                at <= Number(url.searchParams.get("endTime"))
              );
            }),
          );
      }
      return json({ code: -1, msg: "unexpected" }, 404);
    },
  );
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

const fullAccount: Account = {
  spot: [
    { asset: "BTC", free: "0.10000000", locked: "0.05000000" },
    { asset: "XYZ", free: "100.00000000", locked: "0" },
    // 活期理財憑證，與理財持倉重複。
    { asset: "LDBTC", free: "0.20000000", locked: "0" },
    // 零碎資產：價值不足 1 元。
    { asset: "ETH", free: "0.00000100", locked: "0" },
    // 沒有任何交易對的幣無法估值，不列入。
    { asset: "NOPRICE", free: "5.00000000", locked: "0" },
  ],
  funding: [{ asset: "USDT", free: "250.00000000" }],
  flexible: [{ asset: "BTC", totalAmount: "0.20000000" }],
  locked: [{ asset: "USDC", amount: "100.00000000" }],
};

async function configure() {
  await env.DB.prepare(
    "INSERT INTO connector_settings(id, connector_id, encrypted_config, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
  )
    .bind(
      "binance",
      "binance",
      await encryptJson({ apiKey: API_KEY, apiSecret: API_SECRET }, key),
      NOW,
      NOW,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO exchange_rates(currency, rate_to_twd, updated_at) VALUES('USD', ?, ?)",
  )
    .bind(USD_RATE_TO_TWD, NOW)
    .run();
}

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  harness = await createTestD1();
  env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as unknown as Env;
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.mf.dispose();
});

describe("binance sync", () => {
  it("values every wallet in TWD and records completed transfers once", async () => {
    await configure();
    const { fetcher } = binanceMock(fullAccount);

    const first = await syncBinance(env, "manual", fetcher);
    await syncBinance(env, "manual", fetcher);

    expect(first.newRecords.investmentTransactions).toBe(2);
    // BTC：現貨 0.15 + 活期 0.2 = 0.35 × 60,000 × 32 = 672,000
    // USDC：定期 100 × 1 × 32 = 3,200；USDT：資金 250 × 32 = 8,000
    // XYZ：100 × 0.0001 BTC × 60,000 × 32 = 19,200
    expect(
      await rows(
        "SELECT symbol, quantity, market_value, asset_type, as_of_date FROM investment_positions WHERE connector_id = 'binance' ORDER BY symbol",
      ),
    ).toEqual([
      {
        symbol: "BTC",
        quantity: 0.35,
        market_value: 672_000,
        asset_type: "crypto",
        as_of_date: "2026-10-15",
      },
      {
        symbol: "USDC",
        quantity: 100,
        market_value: 3_200,
        asset_type: "crypto",
        as_of_date: "2026-10-15",
      },
      {
        symbol: "USDT",
        quantity: 250,
        market_value: 8_000,
        asset_type: "crypto",
        as_of_date: "2026-10-15",
      },
      {
        symbol: "XYZ",
        quantity: 100,
        market_value: 19_200,
        asset_type: "crypto",
        as_of_date: "2026-10-15",
      },
    ]);
    expect(
      await rows(
        "SELECT asset_type, source, net_worth FROM net_worth_history WHERE source = 'binance'",
      ),
    ).toEqual([
      { asset_type: "crypto", source: "binance", net_worth: 702_400 },
    ]);
    expect(
      await rows(
        "SELECT source_id, symbol, transaction_code, quantity, trade_date FROM investment_transactions WHERE connector_id = 'binance' ORDER BY source_id",
      ),
    ).toEqual([
      {
        source_id: "deposit:dep-1",
        symbol: "BTC",
        transaction_code: "deposit",
        quantity: 0.5,
        trade_date: "2026-10-01",
      },
      // applyTime 為 UTC；15:30 是台北同日 23:30。
      {
        source_id: "withdraw:wd-1",
        symbol: "ETH",
        transaction_code: "withdraw",
        quantity: -1,
        trade_date: "2026-10-10",
      },
    ]);
  });

  it("keeps secrets and full addresses out of raw payloads and cursor", async () => {
    await configure();
    await syncBinance(env, "manual", binanceMock(fullAccount).fetcher);

    const stored = JSON.stringify([
      await rows("SELECT raw_payload FROM investment_positions"),
      await rows("SELECT raw_payload FROM investment_transactions"),
      await rows("SELECT sync_cursor, public_config FROM connector_settings"),
    ]);
    expect(stored).not.toContain(API_KEY);
    expect(stored).not.toContain(API_SECRET);
    expect(stored).not.toContain(withdrawals[0]!.address);
    expect(
      JSON.parse(
        (await rows("SELECT sync_cursor FROM connector_settings"))[0]!
          .sync_cursor as string,
      ),
    ).toEqual({ version: 1, historySyncedUntil: Date.parse(NOW) });
  });

  it("only queries history since the previous sync after the first run", async () => {
    await configure();
    const { fetcher, calls } = binanceMock(fullAccount);
    await syncBinance(env, "manual", fetcher);
    calls.length = 0;
    vi.setSystemTime(new Date(Date.parse(NOW) + DAY_MS));

    await syncBinance(env, "manual", fetcher);

    const depositQueries = calls.filter(
      ({ pathname }) => pathname === "/sapi/v1/capital/deposit/hisrec",
    );
    expect(depositQueries).toHaveLength(1);
    // 與前次重疊 7 天，補上當時仍在處理中的入出金。
    expect(Number(depositQueries[0]!.searchParams.get("startTime"))).toBe(
      Date.parse(NOW) - 7 * DAY_MS,
    );
  });

  it("removes coins sold since an earlier sync on the same day", async () => {
    await configure();
    await syncBinance(env, "manual", binanceMock(fullAccount).fetcher);

    await syncBinance(
      env,
      "manual",
      binanceMock({ ...fullAccount, spot: [], flexible: [] }).fetcher,
    );

    expect(
      await rows(
        "SELECT symbol FROM investment_positions WHERE connector_id = 'binance' ORDER BY symbol",
      ),
    ).toEqual([{ symbol: "USDC" }, { symbol: "USDT" }]);
    expect(
      await rows(
        "SELECT net_worth FROM net_worth_history WHERE source = 'binance'",
      ),
    ).toEqual([{ net_worth: 11_200 }]);
  });

  it("asks the user to fix a rejected API key without writing data", async () => {
    await configure();
    const fetcher = vi.fn(async () =>
      json(
        { code: -2015, msg: "Invalid API-key, IP, or permissions for action." },
        401,
      ),
    ) as unknown as typeof fetch;

    await expect(syncBinance(env, "manual", fetcher)).rejects.toBeInstanceOf(
      NeedsUserActionError,
    );
    expect(await rows("SELECT id FROM investment_positions")).toEqual([]);
  });
});

describe("幣安代發出口", () => {
  it("只轉送 api-gcp.binance.com 的 GET／POST", async () => {
    const outbound = vi.fn(async (_request: Request) => new Response("ok"));
    const allowed = "https://api-gcp.binance.com/api/v3/account";

    expect(
      (await proxyBinanceEgress(new Request(allowed), outbound)).status,
    ).toBe(200);
    expect(
      (
        await proxyBinanceEgress(
          new Request(allowed, { method: "POST" }),
          outbound,
        )
      ).status,
    ).toBe(200);
    for (const request of [
      new Request("https://api.binance.com/api/v3/account"),
      new Request("https://api-gcp.binance.com.evil.test/api/v3/account"),
      new Request("http://api-gcp.binance.com/api/v3/account"),
      new Request(allowed, { method: "DELETE" }),
    ]) {
      expect((await proxyBinanceEgress(request, outbound)).status).toBe(403);
    }
    expect(outbound).toHaveBeenCalledTimes(2);
  });

  it("每次都指向同一個 apac 物件", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const getByName = vi.fn(() => ({ fetch }));
    const fetcher = createBinanceEgressFetcher({
      getByName,
    } as unknown as DurableObjectNamespace);

    await fetcher("https://api-gcp.binance.com/api/v3/time");

    expect(getByName).toHaveBeenCalledWith("binance", { locationHint: "apac" });
  });
});
