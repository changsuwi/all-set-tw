import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import {
  createOkxEgressFetcher,
  proxyOkxEgress,
} from "../../../src/platform/okx-egress";
import { syncOkx } from "../../../src/sources/okx/sync";
import { NeedsUserActionError } from "../../../src/features/sync/errors";

const key = "synthetic-test-encryption-key";
const NOW = "2026-10-15T04:00:00.000Z";
// 合成憑證；格式符合 OKX，但不對應真實帳號。
const API_KEY = "11111111-2222-3333-4444-555555555555";
const API_SECRET = "0123456789ABCDEF0123456789ABCDEF";
const PASSPHRASE = "synthetic-passphrase";
// 1 USD = 32 TWD。
const USD_RATE_TO_TWD = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;

function ok(data: unknown) {
  return new Response(JSON.stringify({ code: "0", msg: "", data }), {
    headers: { "Content-Type": "application/json" },
  });
}

function fail(code: string, status = 200) {
  return new Response(JSON.stringify({ code, msg: "error", data: [] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function rows(sql: string) {
  return (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;
}

const tickers = [
  { instId: "BTC-USDT", last: "60000" },
  { instId: "ETH-USDT", last: "2500" },
  { instId: "OKB-USDT", last: "50" },
];

type Deposit = {
  depId: string;
  ccy: string;
  amt: string;
  state: string;
  ts: string;
};

const baseDeposits: Deposit[] = [
  {
    depId: "d1",
    ccy: "BTC",
    amt: "0.1",
    state: "2",
    ts: String(Date.parse("2026-10-01T02:00:00Z")),
  },
  // 處理中的入金不列入。
  {
    depId: "d2",
    ccy: "ETH",
    amt: "3",
    state: "0",
    ts: String(Date.parse("2026-10-14T02:00:00Z")),
  },
  // 超過一年前的紀錄不列入。
  {
    depId: "d0",
    ccy: "BTC",
    amt: "9",
    state: "2",
    ts: String(Date.parse("2025-01-01T00:00:00Z")),
  },
];

const withdrawals = [
  {
    wdId: "w1",
    ccy: "ETH",
    chain: "ETH-ERC20",
    amt: "1",
    fee: "0.001",
    txId: "0xabc",
    to: "0x1111111111111111111111111111111111111111",
    state: "2",
    ts: String(Date.parse("2026-10-10T15:30:00Z")),
  },
];

function okxMock({
  host = "www.okx.com",
  deposits = baseDeposits,
  tickerRateLimits = 0,
  trading = [
    { ccy: "BTC", eq: "0.05" },
    { ccy: "USDT", eq: "" },
  ],
}: {
  host?: string;
  deposits?: Deposit[];
  tickerRateLimits?: number;
  trading?: Array<{ ccy: string; eq: string }>;
} = {}) {
  const calls: URL[] = [];
  let rateLimitsLeft = tickerRateLimits;
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === "/api/v5/market/tickers") {
        if (rateLimitsLeft > 0) {
          rateLimitsLeft -= 1;
          return fail("50011", 429);
        }
        return ok(tickers);
      }
      // key 只存在於帳號所屬的地區站。
      if (url.hostname !== host) return fail("50119", 401);
      // 驗證簽章：以獨立實作計算 base64(HMAC-SHA256(timestamp + GET + path))。
      const headers = new Headers(init?.headers);
      const timestamp = headers.get("OK-ACCESS-TIMESTAMP") ?? "";
      const expected = createHmac("sha256", API_SECRET)
        .update(`${timestamp}GET${url.pathname}${url.search}`)
        .digest("base64");
      if (
        headers.get("OK-ACCESS-KEY") !== API_KEY ||
        headers.get("OK-ACCESS-PASSPHRASE") !== PASSPHRASE ||
        headers.get("OK-ACCESS-SIGN") !== expected
      ) {
        return fail("50113", 401);
      }
      const after = Number(url.searchParams.get("after") ?? Infinity);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const page = <T extends { ts: string }>(items: T[]) =>
        items
          .filter(({ ts }) => Number(ts) < after)
          .sort((a, b) => Number(b.ts) - Number(a.ts))
          .slice(0, limit);
      switch (url.pathname) {
        case "/api/v5/account/balance":
          return ok([{ details: trading }]);
        case "/api/v5/asset/balances":
          return ok([{ ccy: "USDT", bal: "300" }]);
        case "/api/v5/finance/savings/balance":
          return ok([{ ccy: "BTC", amt: "0.15" }]);
        case "/api/v5/finance/staking-defi/orders-active":
          return ok([{ investData: [{ ccy: "OKB", amt: "10" }] }]);
        case "/api/v5/asset/deposit-history":
          return ok(page(deposits));
        case "/api/v5/asset/withdrawal-history":
          return ok(page(withdrawals));
      }
      return fail("50000", 404);
    },
  );
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

async function configure() {
  await env.DB.prepare(
    "INSERT INTO connector_settings(id, connector_id, encrypted_config, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
  )
    .bind(
      "okx",
      "okx",
      await encryptJson(
        { apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE },
        key,
      ),
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

async function storedCursor() {
  return JSON.parse(
    (await rows("SELECT sync_cursor FROM connector_settings"))[0]!
      .sync_cursor as string,
  );
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

describe("okx sync", () => {
  it("values every wallet in TWD and records completed transfers once", async () => {
    await configure();
    const { fetcher } = okxMock({ tickerRateLimits: 1 });

    const first = await syncOkx(env, "manual", fetcher);
    await syncOkx(env, "manual", fetcher);

    expect(first.newRecords.investmentTransactions).toBe(2);
    // BTC：交易 0.05 + 簡單賺幣 0.15 = 0.2 × 60,000 × 32 = 384,000
    // OKB：鏈上賺幣 10 × 50 × 32 = 16,000；USDT：資金 300 × 32 = 9,600
    expect(
      await rows(
        "SELECT symbol, quantity, market_value, asset_type, as_of_date FROM investment_positions WHERE connector_id = 'okx' ORDER BY symbol",
      ),
    ).toEqual([
      {
        symbol: "BTC",
        quantity: 0.2,
        market_value: 384_000,
        asset_type: "crypto",
        as_of_date: "2026-10-15",
      },
      {
        symbol: "OKB",
        quantity: 10,
        market_value: 16_000,
        asset_type: "crypto",
        as_of_date: "2026-10-15",
      },
      {
        symbol: "USDT",
        quantity: 300,
        market_value: 9_600,
        asset_type: "crypto",
        as_of_date: "2026-10-15",
      },
    ]);
    expect(
      await rows(
        "SELECT net_worth FROM net_worth_history WHERE source = 'okx'",
      ),
    ).toEqual([{ net_worth: 409_600 }]);
    expect(
      await rows(
        "SELECT source_id, symbol, transaction_code, quantity, trade_date FROM investment_transactions WHERE connector_id = 'okx' ORDER BY source_id",
      ),
    ).toEqual([
      {
        source_id: "deposit:d1",
        symbol: "BTC",
        transaction_code: "deposit",
        quantity: 0.1,
        trade_date: "2026-10-01",
      },
      {
        source_id: "withdraw:w1",
        symbol: "ETH",
        transaction_code: "withdraw",
        quantity: -1,
        trade_date: "2026-10-10",
      },
    ]);
  });

  it("detects the regional site of the API key and remembers it", async () => {
    await configure();
    const { fetcher, calls } = okxMock({ host: "my.okx.com" });

    await syncOkx(env, "manual", fetcher);
    expect((await storedCursor()).apiHost).toBe("my.okx.com");

    calls.length = 0;
    await syncOkx(env, "manual", fetcher);
    expect(calls[0]!.hostname).toBe("my.okx.com");
    expect(calls.some(({ hostname }) => hostname === "www.okx.com")).toBe(
      false,
    );
  });

  it("pages through history and only queries since the previous sync afterwards", async () => {
    await configure();
    // 150 筆成功入金，需要兩頁。
    const many: Deposit[] = Array.from({ length: 150 }, (_, index) => ({
      depId: `m${index}`,
      ccy: "USDT",
      amt: "1",
      state: "2",
      ts: String(Date.parse(NOW) - (index + 1) * DAY_MS),
    }));
    const { fetcher, calls } = okxMock({ deposits: many });

    await syncOkx(env, "manual", fetcher);
    expect(
      await rows(
        "SELECT COUNT(*) AS count FROM investment_transactions WHERE source_id LIKE 'deposit:%'",
      ),
    ).toEqual([{ count: 150 }]);
    expect((await storedCursor()).historySyncedUntil).toBe(Date.parse(NOW));

    calls.length = 0;
    vi.setSystemTime(new Date(Date.parse(NOW) + DAY_MS));
    await syncOkx(env, "manual", fetcher);
    // 從前次同步往前重疊 7 天，第一頁就已涵蓋，不再往前翻頁。
    expect(
      calls.filter(
        ({ pathname }) => pathname === "/api/v5/asset/deposit-history",
      ),
    ).toHaveLength(1);
  });

  it("keeps secrets and full addresses out of raw payloads and cursor", async () => {
    await configure();
    await syncOkx(env, "manual", okxMock().fetcher);

    const stored = JSON.stringify([
      await rows("SELECT raw_payload FROM investment_positions"),
      await rows("SELECT raw_payload FROM investment_transactions"),
      await rows("SELECT sync_cursor, public_config FROM connector_settings"),
    ]);
    for (const secret of [
      API_KEY,
      API_SECRET,
      PASSPHRASE,
      withdrawals[0]!.to,
    ]) {
      expect(stored).not.toContain(secret);
    }
  });

  it("asks the user to fix a rejected API key without writing data", async () => {
    await configure();
    const fetcher = vi.fn(async () =>
      fail("50105", 401),
    ) as unknown as typeof fetch;

    await expect(syncOkx(env, "manual", fetcher)).rejects.toBeInstanceOf(
      NeedsUserActionError,
    );
    expect(await rows("SELECT id FROM investment_positions")).toEqual([]);
  });

  it("asks the user to fix an API key that exists on no OKX site", async () => {
    await configure();

    await expect(
      syncOkx(env, "manual", okxMock({ host: "unknown.okx.com" }).fetcher),
    ).rejects.toBeInstanceOf(NeedsUserActionError);
  });
});

describe("OKX 代發出口", () => {
  it("只轉送 OKX 地區站的 GET", async () => {
    const outbound = vi.fn(async (_request: Request) => new Response("ok"));

    for (const host of ["www.okx.com", "my.okx.com", "eea.okx.com"]) {
      expect(
        (
          await proxyOkxEgress(
            new Request(`https://${host}/api/v5/account/balance`),
            outbound,
          )
        ).status,
      ).toBe(200);
    }
    for (const request of [
      new Request("https://okx.com.evil.test/api/v5/account/balance"),
      new Request("http://www.okx.com/api/v5/account/balance"),
      new Request("https://www.okx.com/api/v5/asset/withdrawal", {
        method: "POST",
      }),
    ]) {
      expect((await proxyOkxEgress(request, outbound)).status).toBe(403);
    }
    expect(outbound).toHaveBeenCalledTimes(3);
  });

  it("每次都指向同一個 apac 物件", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const getByName = vi.fn(() => ({ fetch }));
    const fetcher = createOkxEgressFetcher({
      getByName,
    } as unknown as DurableObjectNamespace);

    await fetcher("https://www.okx.com/api/v5/public/time");

    expect(getByName).toHaveBeenCalledWith("okx", { locationHint: "apac" });
  });
});
