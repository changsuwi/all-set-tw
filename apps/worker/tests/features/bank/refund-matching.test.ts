import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { matchRefundsToPurchases } from "../../../src/features/bank/refund-matching";
import { getBankRange } from "../../../src/features/bank/service";

type CardEntry = {
  id: string;
  amount: number;
  day: string;
  description: string;
  accountId?: string;
};

function card({
  id,
  amount,
  day,
  description,
  accountId = "card-1",
}: CardEntry) {
  return {
    id,
    accountId,
    accountType: "credit",
    amount,
    currency: "TWD",
    postedDate: day,
    status: "posted",
    description,
    counterparty: description,
  };
}

describe("退費配對", () => {
  it("部分與分次退費對到同商家最近一筆足額扣款，不跨卡、不超過 90 天", () => {
    const purchases = [
      card({
        id: "rail-old",
        amount: -1_400,
        day: "2026-10-07",
        description: "高鐵智慧型手機ＩＰｈｏｎｅ",
      }),
      card({
        id: "rail",
        amount: -1_400,
        day: "2026-10-09",
        description: "高鐵智慧型手機ＩＰｈｏｎｅ",
      }),
      card({
        id: "rail-small",
        amount: -765,
        day: "2026-10-08",
        description: "高鐵智慧型手機ＩＰｈｏｎｅ",
      }),
      card({
        id: "shopee",
        amount: -507,
        day: "2026-09-20",
        description: "樂購蝦皮－蝦皮直營生活超市TAIPEI",
      }),
      card({
        id: "shopee-later",
        amount: -507,
        day: "2026-09-28",
        description: "樂購蝦皮－蝦皮直營生活超市TAIPEI",
      }),
      card({
        id: "taobao",
        amount: -3_935,
        day: "2026-10-05",
        description: "百貨公司/TAOBAO",
      }),
      card({
        id: "other-card",
        amount: -300,
        day: "2026-10-01",
        description: "全家便利商店",
        accountId: "card-2",
      }),
      card({
        id: "too-old",
        amount: -500,
        day: "2026-06-01",
        description: "誠品書店",
      }),
    ];
    const refunds = [
      card({
        id: "rail-refund",
        amount: 1_360,
        day: "2026-10-10",
        description: "高鐵智慧型手機ＩＰｈｏｎｅ",
      }),
      card({
        id: "shopee-refund-1",
        amount: 254,
        day: "2026-09-24",
        description: "樂購蝦皮－蝦皮直營生活超市TAIPEI",
      }),
      card({
        id: "shopee-refund-2",
        amount: 253,
        day: "2026-09-24",
        description: "樂購蝦皮－蝦皮直營生活超市TAIPEI",
      }),
      card({
        id: "taobao-refund",
        amount: 30,
        day: "2026-10-08",
        description: "A- TAOBAO                125 LONDON WAGB",
      }),
      card({
        id: "other-card-refund",
        amount: 300,
        day: "2026-10-02",
        description: "全家便利商店",
      }),
      card({
        id: "too-old-refund",
        amount: 500,
        day: "2026-10-01",
        description: "誠品書店",
      }),
    ];

    expect(
      Object.fromEntries(matchRefundsToPurchases(refunds, purchases)),
    ).toEqual({
      "rail-refund": "rail",
      "shopee-refund-1": "shopee",
      "shopee-refund-2": "shopee",
      "taobao-refund": "taobao",
    });
  });

  it("消費折抵、回饋與繳款入帳不視為退費", () => {
    const purchases = [
      card({
        id: "apple",
        amount: -90,
        day: "2026-06-20",
        description: "APPLE.COM/BILLA****0009",
      }),
      card({
        id: "fee",
        amount: -4_500,
        day: "2026-08-20",
        description: "鈦金商務卡年費",
      }),
    ];
    const credits = [
      card({
        id: "discount",
        amount: 20,
        day: "2026-06-20",
        description: "信用卡消費折抵_APPLE.COM/BILL",
      }),
      card({
        id: "waiver",
        amount: 4_500,
        day: "2026-08-20",
        description: "鈦金商務卡年費減免",
      }),
      card({
        id: "payment",
        amount: 820,
        day: "2026-09-07",
        description: "永豐自扣已入帳，謝謝！",
      }),
    ];

    expect(matchRefundsToPurchases(credits, purchases).size).toBe(0);
  });
});

describe("退費分類（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;

  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
    const now = "2026-10-15T00:00:00Z";
    await db.batch([
      db
        .prepare(
          `INSERT INTO bank_accounts (id, connector_id, source_id, account_type, currency, created_at, updated_at)
           VALUES ('card-1', 'taishin', 'card-1', 'credit', 'TWD', ?, ?)`,
        )
        .bind(now, now),
      ...[
        ["bakery", "2026-09-30", -259, "芙露米"],
        ["bakery-refund", "2026-10-02", 59, "芙露米"],
        ["shopee", "2026-09-28", -237, "樂購蝦皮股份有限公司"],
        ["shopee-refund", "2026-10-01", 237, "樂購蝦皮股份有限公司"],
      ].map(([id, day, amount, description]) =>
        db
          .prepare(
            `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, counterparty, created_at, updated_at)
             VALUES (?, 'taishin', 'card-1', ?, ?, ?, 'TWD', ?, ?, ?, ?)`,
          )
          .bind(id, id, day, amount, description, description, now, now),
      ),
      ...[
        ["bakery", "food"],
        ["shopee", "shopping"],
        ["shopee-refund", "other-income"],
      ].map(([targetId, categoryId]) =>
        db
          .prepare(
            `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
             VALUES (?, 'bank_transaction', ?, ?, ?, ?)`,
          )
          .bind(`override-${targetId}`, targetId, categoryId, now, now),
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  it("未分類退費沿用上個月扣款的分類；手動分到其他類別時維持收入", async () => {
    const { transactions } = await getBankRange(db, {
      from: "2026-10-01",
      to: "2026-11-01",
    });
    const byId = new Map(
      transactions.map((transaction) => [transaction.id, transaction]),
    );

    expect(byId.get("bakery-refund")?.classification).toEqual({
      categoryId: "food",
      label: "餐飲",
      source: "auto_refund",
      refund: true,
    });
    expect(byId.get("shopee-refund")?.classification).toMatchObject({
      categoryId: "other-income",
      source: "override",
    });
    expect(byId.get("shopee-refund")?.classification?.refund).toBeUndefined();
  });
});
