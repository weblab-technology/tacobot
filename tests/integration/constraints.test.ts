import { afterAll, expect, test } from "vitest";
import { closePool, inRollbackTx } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { transactions, items, users } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

test("self-give insert is rejected by CHECK constraint", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_S", name: "S", dailyAllowance: 5 });
    await expect(
      tx.insert(transactions).values({
        type: "give",
        fromUserId: "U_S",
        toUserId: "U_S",
        amount: 1,
        slackEventId: "self",
      }),
    ).rejects.toThrow(/transactions_shape_and_rule|check constraint|check_violation/i);
  });
});

test("daily_remaining cannot be set negative", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_N", name: "N", dailyAllowance: 5 });
    await expect(
      tx.execute(sql`UPDATE users SET daily_remaining = -1 WHERE id = 'U_N'`),
    ).rejects.toThrow(/users_daily_remaining_nonneg|check constraint|check_violation/i);
  });
});

test("balance cannot exceed received_total", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_X", name: "X", dailyAllowance: 5 });
    await expect(
      tx.execute(sql`UPDATE users SET balance = 10 WHERE id = 'U_X'`),
    ).rejects.toThrow(/users_balance_le_received|check constraint|check_violation/i);
  });
});

test("zero-price item rejected", async () => {
  await inRollbackTx(async (tx) => {
    await expect(
      tx.insert(items).values({ name: "Free", priceTacos: 0 }),
    ).rejects.toThrow(/items_price_positive|check constraint|check_violation/i);
  });
});

test("balance and received_total may go negative (reversal of an already-redeemed give)", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_NEG", name: "N", dailyAllowance: 5 });
    // Both decrement together, preserving balance <= received_total.
    await tx.execute(
      sql`UPDATE users SET balance = -3, received_total = -3 WHERE id = 'U_NEG'`,
    );
    const [u] = await tx.select().from(users).where(eq(users.id, "U_NEG"));
    expect(u.balance).toBe(-3);
    expect(u.receivedTotal).toBe(-3);
  });
});

test("balance still cannot exceed received_total even when both negative", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_INV", name: "I", dailyAllowance: 5 });
    // received_total goes to -5, balance to -3 → balance > received_total.
    await expect(
      tx.execute(
        sql`UPDATE users SET balance = -3, received_total = -5 WHERE id = 'U_INV'`,
      ),
    ).rejects.toThrow(/users_balance_le_received|check constraint|check_violation/i);
  });
});

test("reversal row with a valid shape is accepted", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });
    const [give] = await tx
      .insert(transactions)
      .values({
        type: "give",
        toUserId: "U_R",
        fromUserId: "U_G",
        amount: 1,
        slackEventId: "ShapeTest-give",
      })
      .returning();
    await tx.insert(transactions).values({
      type: "reversal",
      toUserId: "U_R",
      amount: 1,
      slackEventId: "ShapeTest-reversal",
      reversedTransactionId: give.id,
    });
    const reversals = await tx.select().from(transactions).where(eq(transactions.type, "reversal"));
    expect(reversals).toHaveLength(1);
  });
});

test("reversal row with from_user_id is rejected by shape rule", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });
    const [give] = await tx
      .insert(transactions)
      .values({
        type: "give",
        toUserId: "U_R",
        fromUserId: "U_G",
        amount: 1,
        slackEventId: "BadShape-give",
      })
      .returning();
    await expect(
      tx.insert(transactions).values({
        type: "reversal",
        toUserId: "U_R",
        fromUserId: "U_G", // illegal on a reversal row
        amount: 1,
        slackEventId: "BadShape-reversal",
        reversedTransactionId: give.id,
      }),
    ).rejects.toThrow(/transactions_shape_and_rule|check constraint|check_violation/i);
  });
});

test("reversal row without reversed_transaction_id is rejected", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });
    await expect(
      tx.insert(transactions).values({
        type: "reversal",
        toUserId: "U_R",
        amount: 1,
        slackEventId: "MissingRef-reversal",
        // reversedTransactionId omitted
      }),
    ).rejects.toThrow(/transactions_shape_and_rule|check constraint|check_violation/i);
  });
});

test("valid grant row (admin set, no from/item/reversal-ref) is accepted", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_HR", name: "HR", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });
    await tx.execute(sql`
      INSERT INTO transactions (type, to_user_id, admin_user_id, amount)
      VALUES ('grant', 'U_R', 'U_HR', 7)
    `);
    const grants = await tx
      .select()
      .from(transactions)
      .where(eq(transactions.type, "grant"));
    expect(grants).toHaveLength(1);
    expect(grants[0].amount).toBe(7);
    expect(grants[0].adminUserId).toBe("U_HR");
    expect(grants[0].fromUserId).toBeNull();
    expect(grants[0].itemId).toBeNull();
  });
});

test("grant row with from_user_id is rejected by shape rule", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_HR", name: "HR", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });
    await expect(
      tx.execute(sql`
        INSERT INTO transactions (type, to_user_id, from_user_id, admin_user_id, amount)
        VALUES ('grant', 'U_R', 'U_HR', 'U_HR', 1)
      `),
    ).rejects.toThrow(/transactions_shape_and_rule|check constraint|check_violation/i);
  });
});

test("grant row with item_id is rejected by shape rule", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_HR", name: "HR", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });
    const [it] = await tx
      .insert(items)
      .values({ name: "Mug", priceTacos: 5 })
      .returning();
    await expect(
      tx.execute(sql`
        INSERT INTO transactions (type, to_user_id, admin_user_id, item_id, amount)
        VALUES ('grant', 'U_R', 'U_HR', ${it.id}, 1)
      `),
    ).rejects.toThrow(/transactions_shape_and_rule|check constraint|check_violation/i);
  });
});

test("grant row with negative amount is accepted (signed grants)", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_HR", name: "HR", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });
    await tx.execute(sql`
      INSERT INTO transactions (type, to_user_id, admin_user_id, amount)
      VALUES ('grant', 'U_R', 'U_HR', -5)
    `);
    const [row] = await tx
      .select()
      .from(transactions)
      .where(eq(transactions.type, "grant"));
    expect(row.amount).toBe(-5);
  });
});

test("grant row with amount=0 is rejected", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_HR", name: "HR", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });
    await expect(
      tx.execute(sql`
        INSERT INTO transactions (type, to_user_id, admin_user_id, amount)
        VALUES ('grant', 'U_R', 'U_HR', 0)
      `),
    ).rejects.toThrow(/transactions_amount|check constraint|check_violation/i);
  });
});

test("give row with negative amount is still rejected (only grant allows signed)", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });
    await expect(
      tx.execute(sql`
        INSERT INTO transactions (type, to_user_id, from_user_id, amount, slack_event_id)
        VALUES ('give', 'U_R', 'U_G', -1, 'NegGive')
      `),
    ).rejects.toThrow(/transactions_amount|check constraint|check_violation/i);
  });
});

test("a give cannot be reversed twice (UNIQUE on reversed_transaction_id)", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });
    const [give] = await tx
      .insert(transactions)
      .values({
        type: "give",
        toUserId: "U_R",
        fromUserId: "U_G",
        amount: 1,
        slackEventId: "DoubleRev-give",
      })
      .returning();
    await tx.insert(transactions).values({
      type: "reversal",
      toUserId: "U_R",
      amount: 1,
      slackEventId: "DoubleRev-reversal-1",
      reversedTransactionId: give.id,
    });
    await expect(
      tx.insert(transactions).values({
        type: "reversal",
        toUserId: "U_R",
        amount: 1,
        slackEventId: "DoubleRev-reversal-2",
        reversedTransactionId: give.id,
      }),
    ).rejects.toThrow(/reversed_transaction_id|unique|duplicate/i);
  });
});

afterAll(async () => {
  await closePool();
});
