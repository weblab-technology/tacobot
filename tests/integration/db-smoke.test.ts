import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, inRollbackTx } from "./helpers/db";
import { items, users, transactions } from "@/lib/db/schema";

test("schema applied: users, items, transactions are queryable", async () => {
  await inRollbackTx(async (tx) => {
    const u = await tx.select().from(users);
    const i = await tx.select().from(items);
    const t = await tx.select().from(transactions);
    expect(u).toEqual([]);
    expect(i).toEqual([]);
    expect(t).toEqual([]);
  });
});

test("inRollbackTx isolates writes between tests", async () => {
  await inRollbackTx(async (tx) => {
    await tx.insert(users).values({
      id: "U_TEST",
      name: "Test",
      dailyRemaining: 5,
    });
    const rows = await tx.select().from(users).where(eq(users.id, "U_TEST"));
    expect(rows).toHaveLength(1);
  });
  await inRollbackTx(async (tx) => {
    const rows = await tx.select().from(users).where(eq(users.id, "U_TEST"));
    expect(rows).toHaveLength(0); // Previous test rolled back.
  });
});

afterAll(async () => {
  await closePool();
});
