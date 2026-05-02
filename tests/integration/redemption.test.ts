import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, withCleanDb } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { redeem } from "@/lib/admin/redeem";
import { items, transactions, users } from "@/lib/db/schema";

test("redeem deducts balance and writes transaction", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_E", name: "E", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_HR", name: "HR", dailyAllowance: 5 });
    await db.update(users).set({ receivedTotal: 10, balance: 10 }).where(eq(users.id, "U_E"));

    const [it] = await db.insert(items).values({ name: "Hoodie", priceTacos: 5 }).returning();

    const r = await redeem(db, {
      employeeId: "U_E",
      itemId: it.id,
      amount: 5,
      adminId: "U_HR",
      reason: "size M",
    });
    expect(r.kind).toBe("ok");

    const [e] = await db.select().from(users).where(eq(users.id, "U_E"));
    expect(e.balance).toBe(5);
    expect(e.receivedTotal).toBe(10); // unchanged

    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe("redeem");
    expect(txns[0].adminUserId).toBe("U_HR");
    expect(txns[0].itemId).toBe(it.id);
  });
});

test("redeem refuses to overdraw", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_E", name: "E", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_HR", name: "HR", dailyAllowance: 5 });
    await db.update(users).set({ receivedTotal: 3, balance: 3 }).where(eq(users.id, "U_E"));
    const [it] = await db.insert(items).values({ name: "X", priceTacos: 5 }).returning();

    const r = await redeem(db, {
      employeeId: "U_E", itemId: it.id, amount: 5, adminId: "U_HR", reason: null,
    });
    expect(r.kind).toBe("insufficient");
    const [e] = await db.select().from(users).where(eq(users.id, "U_E"));
    expect(e.balance).toBe(3);
    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(0);
  });
});

afterAll(async () => closePool());
