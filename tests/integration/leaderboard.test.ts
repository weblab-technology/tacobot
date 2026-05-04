import { test, expect } from "vitest";
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
