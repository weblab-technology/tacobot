import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, withCleanDb } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { executeGive } from "@/lib/slack/execute";
import { executeReactionReversal } from "@/lib/slack/reverse";
import { transactions, users } from "@/lib/db/schema";

const ALLOWANCE = 5;
const CHANNEL = "C_TAQ";
const TS = "1700.0";

test("reverses the single reaction-give matched by (channel, ts, reactor)", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: ALLOWANCE });

    // Reaction by U_R on U_A's message → 1 taco from U_R to U_A.
    await executeGive(db, {
      giverId: "U_R", giverDecrement: 1,
      transactions: [{
        toUserId: "U_A", fromUserId: "U_R", amount: 1,
        slackEventId: `react-${CHANNEL}-${TS}-U_R-0`,
        slackChannelId: CHANNEL, slackMessageTs: TS, reason: "reaction",
      }],
    });

    const result = await executeReactionReversal(db, {
      channelId: CHANNEL, messageTs: TS, reactor: "U_R", dailyAllowance: ALLOWANCE,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.reversed).toHaveLength(1);
      expect(result.reversed[0]).toMatchObject({
        giverId: "U_R",
        recipientId: "U_A",
        amount: 1,
      });
    }

    const [reactor] = await db.select().from(users).where(eq(users.id, "U_R"));
    expect(reactor.dailyRemaining).toBe(ALLOWANCE);
    const [author] = await db.select().from(users).where(eq(users.id, "U_A"));
    expect(author.balance).toBe(0);
    expect(author.receivedTotal).toBe(0);

    const [reversal] = await db.select().from(transactions).where(eq(transactions.type, "reversal"));
    expect(reversal.reason).toBe("reaction_removed");
    expect(reversal.slackEventId).toMatch(/^unreact-/);
  });
});

test("reverses every give produced by a reaction on a multi-mention message", async () => {
  // Reactions on @-mention messages credit each mention separately, producing
  // multiple give rows. All must be reversed when the reactor unreacts.
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_B", name: "B", dailyAllowance: ALLOWANCE });

    await executeGive(db, {
      giverId: "U_R", giverDecrement: 2,
      transactions: [
        {
          toUserId: "U_A", fromUserId: "U_R", amount: 1,
          slackEventId: `react-${CHANNEL}-${TS}-U_R-0`,
          slackChannelId: CHANNEL, slackMessageTs: TS, reason: "reaction",
        },
        {
          toUserId: "U_B", fromUserId: "U_R", amount: 1,
          slackEventId: `react-${CHANNEL}-${TS}-U_R-1`,
          slackChannelId: CHANNEL, slackMessageTs: TS, reason: "reaction",
        },
      ],
    });

    const result = await executeReactionReversal(db, {
      channelId: CHANNEL, messageTs: TS, reactor: "U_R", dailyAllowance: ALLOWANCE,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.reversed).toHaveLength(2);

    const [reactor] = await db.select().from(users).where(eq(users.id, "U_R"));
    expect(reactor.dailyRemaining).toBe(ALLOWANCE);
    const [a] = await db.select().from(users).where(eq(users.id, "U_A"));
    const [b] = await db.select().from(users).where(eq(users.id, "U_B"));
    expect(a.balance).toBe(0);
    expect(b.balance).toBe(0);
  });
});

test("idempotent on duplicate reaction_removed", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: ALLOWANCE });

    await executeGive(db, {
      giverId: "U_R", giverDecrement: 1,
      transactions: [{
        toUserId: "U_A", fromUserId: "U_R", amount: 1,
        slackEventId: `react-${CHANNEL}-${TS}-U_R-0`,
        slackChannelId: CHANNEL, slackMessageTs: TS, reason: "reaction",
      }],
    });

    const first = await executeReactionReversal(db, {
      channelId: CHANNEL, messageTs: TS, reactor: "U_R", dailyAllowance: ALLOWANCE,
    });
    expect(first.kind).toBe("ok");
    const second = await executeReactionReversal(db, {
      channelId: CHANNEL, messageTs: TS, reactor: "U_R", dailyAllowance: ALLOWANCE,
    });
    expect(second.kind).toBe("noop");

    const reversals = await db.select().from(transactions).where(eq(transactions.type, "reversal"));
    expect(reversals).toHaveLength(1);
  });
});

test("noop when no give matches the (channel, ts, reactor)", async () => {
  await withCleanDb(async (db) => {
    const result = await executeReactionReversal(db, {
      channelId: CHANNEL, messageTs: TS, reactor: "U_NOBODY", dailyAllowance: ALLOWANCE,
    });
    expect(result.kind).toBe("noop");
    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(0);
  });
});

test("does not touch gives from other reactors on the same message", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_R1", name: "R1", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_R2", name: "R2", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: ALLOWANCE });

    await executeGive(db, {
      giverId: "U_R1", giverDecrement: 1,
      transactions: [{
        toUserId: "U_A", fromUserId: "U_R1", amount: 1,
        slackEventId: `react-${CHANNEL}-${TS}-U_R1-0`,
        slackChannelId: CHANNEL, slackMessageTs: TS, reason: "reaction",
      }],
    });
    await executeGive(db, {
      giverId: "U_R2", giverDecrement: 1,
      transactions: [{
        toUserId: "U_A", fromUserId: "U_R2", amount: 1,
        slackEventId: `react-${CHANNEL}-${TS}-U_R2-0`,
        slackChannelId: CHANNEL, slackMessageTs: TS, reason: "reaction",
      }],
    });

    // Only U_R1 unreacts.
    const result = await executeReactionReversal(db, {
      channelId: CHANNEL, messageTs: TS, reactor: "U_R1", dailyAllowance: ALLOWANCE,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.reversed).toHaveLength(1);
      expect(result.reversed[0].giverId).toBe("U_R1");
    }

    const [r1] = await db.select().from(users).where(eq(users.id, "U_R1"));
    const [r2] = await db.select().from(users).where(eq(users.id, "U_R2"));
    const [a] = await db.select().from(users).where(eq(users.id, "U_A"));
    expect(r1.dailyRemaining).toBe(ALLOWANCE); // restored
    expect(r2.dailyRemaining).toBe(ALLOWANCE - 1); // unchanged
    expect(a.balance).toBe(1); // R2's give still stands
    expect(a.receivedTotal).toBe(1);
  });
});

afterAll(async () => closePool());
