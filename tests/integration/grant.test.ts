import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, withCleanDb } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { grant } from "@/lib/admin/grant";
import { transactions, users } from "@/lib/db/schema";

test("positive grant credits balance and received_total together", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_E", name: "E", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_HR", name: "HR", dailyAllowance: 5 });

    const r = await grant(db, {
      recipientId: "U_E",
      amount: 5,
      adminId: "U_HR",
      reason: "onboarding",
    });
    expect(r.kind).toBe("ok");

    const [e] = await db.select().from(users).where(eq(users.id, "U_E"));
    expect(e.balance).toBe(5);
    expect(e.receivedTotal).toBe(5);
    expect(e.dailyRemaining).toBe(5); // unchanged

    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe("grant");
    expect(txns[0].toUserId).toBe("U_E");
    expect(txns[0].adminUserId).toBe("U_HR");
    expect(txns[0].fromUserId).toBeNull();
    expect(txns[0].itemId).toBeNull();
    expect(txns[0].amount).toBe(5);
    expect(txns[0].reason).toBe("onboarding");
  });
});

test("negative grant debits balance and received_total (allowed to go negative)", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_E", name: "E", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_HR", name: "HR", dailyAllowance: 5 });
    // Seed the user with some received tacos so we can drop them below the
    // starting balance. Both columns move together to preserve the
    // balance <= received_total invariant.
    await db
      .update(users)
      .set({ receivedTotal: 50, balance: 50 })
      .where(eq(users.id, "U_E"));

    const r = await grant(db, {
      recipientId: "U_E",
      amount: -45,
      adminId: "U_HR",
      reason: "beta normalization",
    });
    expect(r.kind).toBe("ok");

    const [e] = await db.select().from(users).where(eq(users.id, "U_E"));
    expect(e.balance).toBe(5);
    expect(e.receivedTotal).toBe(5);

    const [txn] = await db.select().from(transactions);
    expect(txn.type).toBe("grant");
    expect(txn.amount).toBe(-45);
  });
});

test("negative grant may push balance below zero", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_E", name: "E", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_HR", name: "HR", dailyAllowance: 5 });

    await grant(db, {
      recipientId: "U_E",
      amount: -3,
      adminId: "U_HR",
      reason: null,
    });

    const [e] = await db.select().from(users).where(eq(users.id, "U_E"));
    expect(e.balance).toBe(-3);
    expect(e.receivedTotal).toBe(-3);
  });
});

test("self-grant (admin == recipient) is accepted", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_HR", name: "HR", dailyAllowance: 5 });

    const r = await grant(db, {
      recipientId: "U_HR",
      amount: 2,
      adminId: "U_HR",
      reason: null,
    });
    expect(r.kind).toBe("ok");

    const [u] = await db.select().from(users).where(eq(users.id, "U_HR"));
    expect(u.balance).toBe(2);
    expect(u.receivedTotal).toBe(2);
  });
});

afterAll(async () => closePool());
