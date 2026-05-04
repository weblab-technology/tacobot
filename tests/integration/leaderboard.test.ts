import { test, expect } from "vitest";
import { sql } from "drizzle-orm";
import { inRollbackTx } from "./helpers/db";
import { upsertUser, getLeaderboard } from "@/lib/db/queries";
import { transactions } from "@/lib/db/schema";

async function seedGive(
  tx: Parameters<Parameters<typeof inRollbackTx>[0]>[0],
  opts: {
    fromId: string;
    toId: string;
    amount: number;
    channel?: string;
    ts?: string;
    eventId: string;
    createdAt?: Date;
  },
) {
  const ch = opts.channel ?? "C_TEST";
  const ts = opts.ts ?? `${Date.now()}.0`;
  const [row] = await tx
    .insert(transactions)
    .values({
      type: "give",
      fromUserId: opts.fromId,
      toUserId: opts.toId,
      amount: opts.amount,
      slackEventId: opts.eventId,
      slackChannelId: ch,
      slackMessageTs: ts,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function seedReversal(
  tx: Parameters<Parameters<typeof inRollbackTx>[0]>[0],
  opts: { reversedId: string; toId: string; amount: number; eventId: string; createdAt?: Date },
) {
  await tx.insert(transactions).values({
    type: "reversal",
    toUserId: opts.toId,
    amount: opts.amount,
    reversedTransactionId: opts.reversedId,
    slackEventId: opts.eventId,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
}

test("received: ranks active users by net received tacos, descending", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_B", name: "B", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_C", name: "C", dailyAllowance: 5 });

    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 1, eventId: "e1" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 2, eventId: "e2" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_B", amount: 5, eventId: "e3" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_C", amount: 1, eventId: "e4" });

    const rows = await getLeaderboard(tx, {
      metric: "received",
      since: null,
      channel: null,
    });

    expect(rows).toEqual([
      { userId: "U_B", total: 5 },
      { userId: "U_A", total: 3 },
      { userId: "U_C", total: 1 },
    ]);
  });
});

test("received: reversal subtracts even when reversal happened outside the period", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    // Original give: 2026-05-04 (inside "this week" if now is also that week)
    const giveId = await seedGive(tx, {
      fromId: "U_GIVER",
      toId: "U_A",
      amount: 3,
      eventId: "e1",
      createdAt: new Date("2026-05-04T10:00:00Z"),
    });
    // Reversal happened a week later (outside any small window starting at the give date)
    await seedReversal(tx, {
      reversedId: giveId,
      toId: "U_A",
      amount: 3,
      eventId: "rev-e1",
      createdAt: new Date("2026-05-15T10:00:00Z"),
    });

    // Window includes the give but not the reversal — reversal still subtracts.
    const rows = await getLeaderboard(tx, {
      metric: "received",
      since: new Date("2026-05-04T00:00:00Z"),
      channel: null,
    });

    expect(rows).toEqual([]); // net is 0, filtered by HAVING
  });
});

test("received: a partially-reversed give nets to the remainder", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    const giveA1 = await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 2, eventId: "g1" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 3, eventId: "g2" });
    await seedReversal(tx, { reversedId: giveA1, toId: "U_A", amount: 2, eventId: "rev-g1" });

    const rows = await getLeaderboard(tx, { metric: "received", since: null, channel: null });
    expect(rows).toEqual([{ userId: "U_A", total: 3 }]);
  });
});

test("given: ranks active givers by net amount given, with reversals subtracted", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_X", name: "X", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_Y", name: "Y", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_R1", name: "R1", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R2", name: "R2", dailyAllowance: 5 });

    // X gives 4 total, has 1 reversed → net 3
    const gx1 = await seedGive(tx, { fromId: "U_X", toId: "U_R1", amount: 1, eventId: "x1" });
    await seedGive(tx, { fromId: "U_X", toId: "U_R2", amount: 3, eventId: "x2" });
    await seedReversal(tx, { reversedId: gx1, toId: "U_R1", amount: 1, eventId: "rev-x1" });

    // Y gives 5
    await seedGive(tx, { fromId: "U_Y", toId: "U_R1", amount: 5, eventId: "y1" });

    const rows = await getLeaderboard(tx, { metric: "given", since: null, channel: null });
    expect(rows).toEqual([
      { userId: "U_Y", total: 5 },
      { userId: "U_X", total: 3 },
    ]);
  });
});

test("combined: sums received + given per user; giver-only and receiver-only both rank", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_BOTH", name: "Both", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_GIVER_ONLY", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_RECV_ONLY", name: "Recv", dailyAllowance: 5 });

    // U_BOTH gives 2 to U_RECV_ONLY, receives 4 from U_GIVER_ONLY → combined 6
    await seedGive(tx, { fromId: "U_BOTH", toId: "U_RECV_ONLY", amount: 2, eventId: "b1" });
    await seedGive(tx, { fromId: "U_GIVER_ONLY", toId: "U_BOTH", amount: 4, eventId: "g1" });
    // U_GIVER_ONLY gives 1 more to U_RECV_ONLY → given 5 total
    await seedGive(tx, { fromId: "U_GIVER_ONLY", toId: "U_RECV_ONLY", amount: 1, eventId: "g2" });

    const rows = await getLeaderboard(tx, { metric: "combined", since: null, channel: null });

    // U_BOTH: 4 received + 2 given = 6
    // U_GIVER_ONLY: 0 received + 5 given = 5
    // U_RECV_ONLY: 3 received + 0 given = 3
    expect(rows).toEqual([
      { userId: "U_BOTH", total: 6 },
      { userId: "U_GIVER_ONLY", total: 5 },
      { userId: "U_RECV_ONLY", total: 3 },
    ]);
  });
});

test("period filter: only counts gives whose created_at is >= since", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    await seedGive(tx, {
      fromId: "U_GIVER",
      toId: "U_A",
      amount: 2,
      eventId: "old",
      createdAt: new Date("2026-05-03T23:00:00Z"),
    });
    await seedGive(tx, {
      fromId: "U_GIVER",
      toId: "U_A",
      amount: 5,
      eventId: "today",
      createdAt: new Date("2026-05-04T01:00:00Z"),
    });

    const rows = await getLeaderboard(tx, {
      metric: "received",
      since: new Date("2026-05-04T00:00:00Z"),
      channel: null,
    });
    expect(rows).toEqual([{ userId: "U_A", total: 5 }]);
  });
});

test("channel filter: excludes gives in other channels", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 1, channel: "C_X", eventId: "x" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 4, channel: "C_Y", eventId: "y" });

    const rows = await getLeaderboard(tx, {
      metric: "received",
      since: null,
      channel: "C_Y",
    });
    expect(rows).toEqual([{ userId: "U_A", total: 4 }]);
  });
});

test("inactive users are excluded even when they have received tacos", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_GONE", name: "Gone", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_HERE", name: "Here", dailyAllowance: 5 });
    // Deactivate U_GONE
    await tx.execute(sql`UPDATE users SET is_active = false WHERE id = 'U_GONE'`);

    await seedGive(tx, { fromId: "U_GIVER", toId: "U_GONE", amount: 7, eventId: "g1" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_HERE", amount: 2, eventId: "g2" });

    const rows = await getLeaderboard(tx, { metric: "received", since: null, channel: null });
    expect(rows).toEqual([{ userId: "U_HERE", total: 2 }]);
  });
});

test("tie-break: equal totals order by user_id ascending", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_B", name: "B", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    await seedGive(tx, { fromId: "U_GIVER", toId: "U_B", amount: 3, eventId: "b" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 3, eventId: "a" });

    const rows = await getLeaderboard(tx, { metric: "received", since: null, channel: null });
    expect(rows).toEqual([
      { userId: "U_A", total: 3 },
      { userId: "U_B", total: 3 },
    ]);
  });
});
