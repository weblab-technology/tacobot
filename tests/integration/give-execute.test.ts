import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, inRollbackTx } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { executeGive } from "@/lib/slack/execute";
import { users, transactions } from "@/lib/db/schema";

test("executeGive decrements giver, increments receiver, writes transaction", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });

    const result = await executeGive(tx, {
      giverId: "U_G",
      giverDecrement: 1,
      transactions: [{
        toUserId: "U_R",
        fromUserId: "U_G",
        amount: 1,
        slackEventId: "Ev1-0",
        slackChannelId: "C",
        slackMessageTs: "1.0",
        reason: "thanks",
      }],
    });

    expect(result.kind).toBe("ok");
    const [g] = await tx.select().from(users).where(eq(users.id, "U_G"));
    const [r] = await tx.select().from(users).where(eq(users.id, "U_R"));
    expect(g.dailyRemaining).toBe(4);
    expect(r.receivedTotal).toBe(1);
    expect(r.balance).toBe(1);

    const txns = await tx.select().from(transactions);
    expect(txns).toHaveLength(1);
    expect(txns[0].slackEventId).toBe("Ev1-0");
  });
});

test("executeGive returns over_allowance and rolls back when giver lacks tacos", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await tx.update(users).set({ dailyRemaining: 0 }).where(eq(users.id, "U_G"));
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });

    const result = await executeGive(tx, {
      giverId: "U_G",
      giverDecrement: 1,
      transactions: [{
        toUserId: "U_R",
        fromUserId: "U_G",
        amount: 1,
        slackEventId: "Ev2-0",
        slackChannelId: "C",
        slackMessageTs: "2.0",
        reason: null,
      }],
    });

    expect(result.kind).toBe("over_allowance");
    const txns = await tx.select().from(transactions);
    expect(txns).toHaveLength(0);
    const [r] = await tx.select().from(users).where(eq(users.id, "U_R"));
    expect(r.receivedTotal).toBe(0);
  });
});

afterAll(async () => {
  await closePool();
});
