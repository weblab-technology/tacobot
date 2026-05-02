import { afterAll, expect, test } from "vitest";
import { closePool, inRollbackTx } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { transactions, items } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

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

afterAll(async () => {
  await closePool();
});
