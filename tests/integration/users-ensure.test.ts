import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, inRollbackTx } from "./helpers/db";
import { ensureUserExists, upsertUser } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";

test("ensureUserExists inserts a row with name=id and default counters", async () => {
  await inRollbackTx(async (tx) => {
    await ensureUserExists(tx, { id: "U_NEW", dailyAllowance: 5 });
    const [row] = await tx.select().from(users).where(eq(users.id, "U_NEW"));
    expect(row).toBeDefined();
    expect(row.name).toBe("U_NEW");
    expect(row.dailyRemaining).toBe(5);
    expect(row.receivedTotal).toBe(0);
    expect(row.balance).toBe(0);
    expect(row.isActive).toBe(true);
  });
});

test("ensureUserExists does not overwrite existing name or counters", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_E", name: "Real Name", dailyAllowance: 5 });
    await tx.update(users)
      .set({ receivedTotal: 9, balance: 9, dailyRemaining: 1 })
      .where(eq(users.id, "U_E"));
    await ensureUserExists(tx, { id: "U_E", dailyAllowance: 5 });
    const [row] = await tx.select().from(users).where(eq(users.id, "U_E"));
    expect(row.name).toBe("Real Name");
    expect(row.receivedTotal).toBe(9);
    expect(row.balance).toBe(9);
    expect(row.dailyRemaining).toBe(1);
  });
});

afterAll(async () => {
  await closePool();
});
