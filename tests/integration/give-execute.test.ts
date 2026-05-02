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

test("executeGive credits all recipients atomically", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_B", name: "B", dailyAllowance: 5 });

    const result = await executeGive(tx, {
      giverId: "U_G",
      giverDecrement: 4, // 2 each
      transactions: [
        {
          toUserId: "U_A",
          fromUserId: "U_G",
          amount: 2,
          slackEventId: "Ev3-0",
          slackChannelId: "C",
          slackMessageTs: "3.0",
          reason: null,
        },
        {
          toUserId: "U_B",
          fromUserId: "U_G",
          amount: 2,
          slackEventId: "Ev3-1",
          slackChannelId: "C",
          slackMessageTs: "3.0",
          reason: null,
        },
      ],
    });

    expect(result.kind).toBe("ok");
    const [g] = await tx.select().from(users).where(eq(users.id, "U_G"));
    const [a] = await tx.select().from(users).where(eq(users.id, "U_A"));
    const [b] = await tx.select().from(users).where(eq(users.id, "U_B"));
    expect(g.dailyRemaining).toBe(1);
    expect(a.balance).toBe(2);
    expect(b.balance).toBe(2);
    const txns = await tx.select().from(transactions);
    expect(txns).toHaveLength(2);
  });
});

test("executeGive returns duplicate and does not re-credit on retry", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });

    const plan = {
      giverId: "U_G",
      giverDecrement: 1,
      transactions: [
        {
          toUserId: "U_R",
          fromUserId: "U_G",
          amount: 1,
          slackEventId: "Ev_DUP-0",
          slackChannelId: "C",
          slackMessageTs: "1.0",
          reason: null,
        },
      ],
    };

    const first = await executeGive(tx, plan);
    expect(first.kind).toBe("ok");

    const second = await executeGive(tx, plan);
    expect(second.kind).toBe("duplicate");

    const [g] = await tx.select().from(users).where(eq(users.id, "U_G"));
    const [r] = await tx.select().from(users).where(eq(users.id, "U_R"));
    expect(g.dailyRemaining).toBe(4); // not 3
    expect(r.balance).toBe(1); // not 2

    const txns = await tx.select().from(transactions);
    expect(txns).toHaveLength(1);
  });
});

afterAll(async () => {
  await closePool();
});
