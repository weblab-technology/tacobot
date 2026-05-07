import { test, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { inRollbackTx } from "./helpers/db";
import { upsertUser, getLeaderboard } from "@/lib/db/queries";
import { transactions, users } from "@/lib/db/schema";

// Seed helpers mirror what production paths (executeGive, grant, reverse)
// do to the cached counters on `users` — leaderboard queries can read those
// counters directly for unfiltered views, so tests must keep them coherent
// with the transactions they insert.

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
  await tx
    .update(users)
    .set({
      balance: sql`${users.balance} + ${opts.amount}`,
      receivedTotal: sql`${users.receivedTotal} + ${opts.amount}`,
    })
    .where(eq(users.id, opts.toId));
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
  await tx
    .update(users)
    .set({
      balance: sql`${users.balance} - ${opts.amount}`,
      receivedTotal: sql`${users.receivedTotal} - ${opts.amount}`,
    })
    .where(eq(users.id, opts.toId));
}

async function seedGrant(
  tx: Parameters<Parameters<typeof inRollbackTx>[0]>[0],
  opts: { adminId: string; toId: string; amount: number; createdAt?: Date },
) {
  await tx.insert(transactions).values({
    type: "grant",
    adminUserId: opts.adminId,
    toUserId: opts.toId,
    amount: opts.amount,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  await tx
    .update(users)
    .set({
      balance: sql`${users.balance} + ${opts.amount}`,
      receivedTotal: sql`${users.receivedTotal} + ${opts.amount}`,
    })
    .where(eq(users.id, opts.toId));
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

test("redeemable: ranks active users by current balance, descending", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_B", name: "B", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_C", name: "C", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_ZERO", name: "Zero", dailyAllowance: 5 });
    await tx.execute(
      sql`UPDATE users SET balance = 7, received_total = 7 WHERE id = 'U_A'`,
    );
    await tx.execute(
      sql`UPDATE users SET balance = 12, received_total = 12 WHERE id = 'U_B'`,
    );
    await tx.execute(
      sql`UPDATE users SET balance = 3, received_total = 3 WHERE id = 'U_C'`,
    );

    const rows = await getLeaderboard(tx, {
      metric: "redeemable",
      since: null,
      channel: null,
    });

    expect(rows).toEqual([
      { userId: "U_B", total: 12 },
      { userId: "U_A", total: 7 },
      { userId: "U_C", total: 3 },
    ]);
  });
});

test("redeemable: excludes inactive users and zero/negative balances", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GONE", name: "Gone", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_NEG", name: "Neg", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_OK", name: "OK", dailyAllowance: 5 });
    await tx.execute(
      sql`UPDATE users SET balance = 99, received_total = 99 WHERE id = 'U_GONE'`,
    );
    await tx.execute(sql`UPDATE users SET is_active = false WHERE id = 'U_GONE'`);
    await tx.execute(
      sql`UPDATE users SET balance = -2, received_total = -2 WHERE id = 'U_NEG'`,
    );
    await tx.execute(
      sql`UPDATE users SET balance = 4, received_total = 4 WHERE id = 'U_OK'`,
    );

    const rows = await getLeaderboard(tx, {
      metric: "redeemable",
      since: null,
      channel: null,
    });

    expect(rows).toEqual([{ userId: "U_OK", total: 4 }]);
  });
});

test("redeemable: ignores period and channel filters", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });
    await tx.execute(
      sql`UPDATE users SET balance = 6, received_total = 6 WHERE id = 'U_A'`,
    );

    const rows = await getLeaderboard(tx, {
      metric: "redeemable",
      since: new Date("2099-01-01T00:00:00Z"),
      channel: "C_NONEXISTENT",
    });

    expect(rows).toEqual([{ userId: "U_A", total: 6 }]);
  });
});

test("received: positive grant adds to user's total", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_ADMIN", name: "Admin", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 2, eventId: "g1" });
    await seedGrant(tx, { adminId: "U_ADMIN", toId: "U_A", amount: 5 });

    const rows = await getLeaderboard(tx, { metric: "received", since: null, channel: null });
    expect(rows).toEqual([{ userId: "U_A", total: 7 }]);
  });
});

test("received: negative grant (zero-balances reset) reduces user's total below gives", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_ADMIN", name: "Admin", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_MAXX", name: "Maxx", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_ME", name: "Me", dailyAllowance: 5 });

    // Pre-reset gives
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_MAXX", amount: 1, eventId: "pre1" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_MAXX", amount: 1, eventId: "pre2" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_MAXX", amount: 1, eventId: "pre3" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_ME", amount: 1, eventId: "pre4" });

    // Zero-balances reset zeros pre-reset receipts via signed grants.
    await seedGrant(tx, { adminId: "U_ADMIN", toId: "U_MAXX", amount: -3 });
    await seedGrant(tx, { adminId: "U_ADMIN", toId: "U_ME", amount: -1 });

    // Post-reset gives
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_MAXX", amount: 2, eventId: "post1" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_MAXX", amount: 1, eventId: "post2" });

    const rows = await getLeaderboard(tx, { metric: "received", since: null, channel: null });
    // Maxx: 1+1+1-3+2+1 = 3; Me: 1-1 = 0 (filtered by HAVING > 0)
    expect(rows).toEqual([{ userId: "U_MAXX", total: 3 }]);
  });
});

test("received: grant outside the period window is excluded", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_ADMIN", name: "Admin", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    // Grant before the window — should NOT count
    await seedGrant(tx, {
      adminId: "U_ADMIN",
      toId: "U_A",
      amount: 5,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    });
    // Grant inside the window — should count
    await seedGrant(tx, {
      adminId: "U_ADMIN",
      toId: "U_A",
      amount: 2,
      createdAt: new Date("2026-05-04T12:00:00Z"),
    });

    const rows = await getLeaderboard(tx, {
      metric: "received",
      since: new Date("2026-05-04T00:00:00Z"),
      channel: null,
    });
    expect(rows).toEqual([{ userId: "U_A", total: 2 }]);
  });
});

test("received: channel filter excludes all grants (grants have no channel)", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_ADMIN", name: "Admin", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 3, channel: "C_X", eventId: "x" });
    // Grant to U_A — should be ignored under any channel filter
    await seedGrant(tx, { adminId: "U_ADMIN", toId: "U_A", amount: 100 });

    const rows = await getLeaderboard(tx, {
      metric: "received",
      since: null,
      channel: "C_X",
    });
    expect(rows).toEqual([{ userId: "U_A", total: 3 }]);
  });
});

test("given: grants do not appear in given metric", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_ADMIN", name: "Admin", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    // Admin issues a grant — must NOT count as given by admin.
    await seedGrant(tx, { adminId: "U_ADMIN", toId: "U_A", amount: 10 });

    const rows = await getLeaderboard(tx, { metric: "given", since: null, channel: null });
    expect(rows).toEqual([]);
  });
});

test("combined: includes grant net on the receiving side", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_ADMIN", name: "Admin", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 2, eventId: "g1" });
    await seedGrant(tx, { adminId: "U_ADMIN", toId: "U_A", amount: 3 });

    const rows = await getLeaderboard(tx, { metric: "combined", since: null, channel: null });
    // U_A: 5 received + 0 given = 5; U_GIVER: 0 received + 2 given = 2
    expect(rows).toEqual([
      { userId: "U_A", total: 5 },
      { userId: "U_GIVER", total: 2 },
    ]);
  });
});

test("received: user with only grants (no peer gives) appears on leaderboard", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_ADMIN", name: "Admin", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_NEW", name: "New", dailyAllowance: 5 });

    await seedGrant(tx, { adminId: "U_ADMIN", toId: "U_NEW", amount: 4 });

    const rows = await getLeaderboard(tx, { metric: "received", since: null, channel: null });
    expect(rows).toEqual([{ userId: "U_NEW", total: 4 }]);
  });
});

test("received (all-time): trusts users.received_total when transactions diverge (post-purge)", async () => {
  // Reproduces the GA scenario: pre-cutover gives + a zero-balances grant in
  // `transactions`, followed by `purge-channel-history` hard-deleting the
  // pre-cutover gives without touching cached counters. Aggregating from
  // `transactions` would net to a negative or zero, but `users.received_total`
  // is the source of truth for lifetime receipts.
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_ADMIN", name: "Admin", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_MAXX", name: "Maxx", dailyAllowance: 5 });

    // Surviving post-purge gives + the (now-orphan) zero-balances grant.
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_MAXX", amount: 2, eventId: "post1" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_MAXX", amount: 1, eventId: "post2" });
    await seedGrant(tx, { adminId: "U_ADMIN", toId: "U_MAXX", amount: -9 });

    // Force the cached counter to the value the production scenario shows
    // (3) — what `users.received_total` would read after the purge ran
    // between the zero-balances and the post-reset gives.
    await tx.execute(
      sql`UPDATE users SET received_total = 3, balance = 3 WHERE id = 'U_MAXX'`,
    );

    const rows = await getLeaderboard(tx, { metric: "received", since: null, channel: null });
    expect(rows).toEqual([{ userId: "U_MAXX", total: 3 }]);
  });
});

test("received (filtered): still aggregates from transactions even when counter diverges", async () => {
  // Period and channel filters can't be answered by the cached counter, so
  // they fall back to transaction aggregation. Tests that the fallback path
  // is reachable.
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    await seedGive(tx, {
      fromId: "U_GIVER",
      toId: "U_A",
      amount: 4,
      eventId: "g1",
      createdAt: new Date("2026-05-04T01:00:00Z"),
    });
    // Manually pull received_total below what transactions imply.
    await tx.execute(sql`UPDATE users SET received_total = 0, balance = 0 WHERE id = 'U_A'`);

    const rows = await getLeaderboard(tx, {
      metric: "received",
      since: new Date("2026-05-04T00:00:00Z"),
      channel: null,
    });
    expect(rows).toEqual([{ userId: "U_A", total: 4 }]);
  });
});

test("received: inactive recipient excluded even with positive grant", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_ADMIN", name: "Admin", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_GONE", name: "Gone", dailyAllowance: 5 });
    await tx.execute(sql`UPDATE users SET is_active = false WHERE id = 'U_GONE'`);

    await seedGrant(tx, { adminId: "U_ADMIN", toId: "U_GONE", amount: 9 });

    const rows = await getLeaderboard(tx, { metric: "received", since: null, channel: null });
    expect(rows).toEqual([]);
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
