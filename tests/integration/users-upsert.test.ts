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

test("upsertUser reactivates a previously-deactivated user", async () => {
  // Once a row flipped to is_active=false (sync-users sweep, user_change
  // deleted=true), every later call from sync-users / team_join / user_change /
  // lazy paths must restore is_active=true. Otherwise the user is permanently
  // invisible to the admin /users page.
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_DEAD", name: "Old", dailyAllowance: 5 });
    await tx.update(users).set({ isActive: false }).where(eq(users.id, "U_DEAD"));
    await upsertUser(tx, { id: "U_DEAD", name: "Resurrected", dailyAllowance: 5 });
    const [row] = await tx.select().from(users).where(eq(users.id, "U_DEAD"));
    expect(row.isActive).toBe(true);
    expect(row.name).toBe("Resurrected");
  });
});

afterAll(async () => {
  await closePool();
});
