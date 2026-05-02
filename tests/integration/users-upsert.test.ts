import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, inRollbackTx } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";

test("upsertUser inserts a new user with default daily allowance", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_NEW", name: "Alice", dailyAllowance: 5 });
    const [row] = await tx.select().from(users).where(eq(users.id, "U_NEW"));
    expect(row).toBeDefined();
    expect(row.dailyRemaining).toBe(5);
    expect(row.receivedTotal).toBe(0);
    expect(row.balance).toBe(0);
    expect(row.isActive).toBe(true);
  });
});

test("upsertUser refreshes name on existing user without resetting counters", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_E", name: "Old", dailyAllowance: 5 });
    await tx.update(users)
      .set({ receivedTotal: 7, balance: 7, dailyRemaining: 2 })
      .where(eq(users.id, "U_E"));
    await upsertUser(tx, { id: "U_E", name: "New", dailyAllowance: 5 });
    const [row] = await tx.select().from(users).where(eq(users.id, "U_E"));
    expect(row.name).toBe("New");
    expect(row.receivedTotal).toBe(7);
    expect(row.balance).toBe(7);
    expect(row.dailyRemaining).toBe(2);
  });
});

afterAll(async () => {
  await closePool();
});
