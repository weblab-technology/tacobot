import { afterAll, expect, test } from "vitest";
import { eq, and } from "drizzle-orm";
import { closePool, withCleanDb } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { executeGive } from "@/lib/slack/execute";
import { executeMessageReversal } from "@/lib/slack/reverse";
import { redeem } from "@/lib/admin/redeem";
import { items, transactions, users } from "@/lib/db/schema";

const ALLOWANCE = 5;
const CHANNEL = "C_TAQ";
const TS = "1700.0";

test("reverses every give tied to a deleted message and restores giver allowance", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_G", name: "G", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_B", name: "B", dailyAllowance: ALLOWANCE });

    // Multi-recipient give: 2 tacos × 2 recipients = 4 from giver.
    const give = await executeGive(db, {
      giverId: "U_G",
      giverDecrement: 4,
      transactions: [
        {
          toUserId: "U_A", fromUserId: "U_G", amount: 2,
          slackEventId: "EvDel-0", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
        },
        {
          toUserId: "U_B", fromUserId: "U_G", amount: 2,
          slackEventId: "EvDel-1", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
        },
      ],
    });
    expect(give.kind).toBe("ok");

    const result = await executeMessageReversal(db, {
      channelId: CHANNEL, messageTs: TS, dailyAllowance: ALLOWANCE,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.reversed).toHaveLength(2);
      expect(result.reversed.map((r) => r.recipientId).sort()).toEqual(["U_A", "U_B"]);
    }

    const [g] = await db.select().from(users).where(eq(users.id, "U_G"));
    expect(g.dailyRemaining).toBe(ALLOWANCE); // restored, capped at allowance
    const [a] = await db.select().from(users).where(eq(users.id, "U_A"));
    const [b] = await db.select().from(users).where(eq(users.id, "U_B"));
    expect(a.balance).toBe(0);
    expect(a.receivedTotal).toBe(0);
    expect(b.balance).toBe(0);
    expect(b.receivedTotal).toBe(0);

    const reversals = await db.select().from(transactions).where(eq(transactions.type, "reversal"));
    expect(reversals).toHaveLength(2);
    for (const r of reversals) {
      expect(r.reversedTransactionId).not.toBeNull();
      expect(r.fromUserId).toBeNull();
      expect(r.adminUserId).toBeNull();
      expect(r.itemId).toBeNull();
      expect(r.reason).toBe("message_deleted");
    }
  });
});

test("dailyRemaining restoration is capped at dailyAllowance (cross-midnight)", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_G", name: "G", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: ALLOWANCE });

    await executeGive(db, {
      giverId: "U_G", giverDecrement: 2,
      transactions: [{
        toUserId: "U_R", fromUserId: "U_G", amount: 2,
        slackEventId: "EvCap-0", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
      }],
    });
    // Simulate the cron resetting allowance after the give: dailyRemaining
    // is back to full, even though 2 tacos have already been given.
    await db.update(users).set({ dailyRemaining: ALLOWANCE }).where(eq(users.id, "U_G"));

    await executeMessageReversal(db, {
      channelId: CHANNEL, messageTs: TS, dailyAllowance: ALLOWANCE,
    });

    const [g] = await db.select().from(users).where(eq(users.id, "U_G"));
    expect(g.dailyRemaining).toBe(ALLOWANCE); // capped, not 7
  });
});

test("balance and receivedTotal can go negative when recipient already redeemed", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_G", name: "G", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_HR", name: "HR", dailyAllowance: ALLOWANCE });

    await executeGive(db, {
      giverId: "U_G", giverDecrement: 3,
      transactions: [{
        toUserId: "U_R", fromUserId: "U_G", amount: 3,
        slackEventId: "EvNeg-0", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
      }],
    });
    const [it] = await db.insert(items).values({ name: "Mug", priceTacos: 3 }).returning();

    // Recipient redeems all 3 tacos.
    const r = await redeem(db, {
      employeeId: "U_R", itemId: it.id, amount: 3, adminId: "U_HR", reason: null,
    });
    expect(r.kind).toBe("ok");

    // Now reverse the original give. Balance + receivedTotal go negative.
    const result = await executeMessageReversal(db, {
      channelId: CHANNEL, messageTs: TS, dailyAllowance: ALLOWANCE,
    });
    expect(result.kind).toBe("ok");

    const [user] = await db.select().from(users).where(eq(users.id, "U_R"));
    // Redeem only decremented balance, leaving received_total at 3. The
    // reversal then subtracts 3 from both: receivedTotal = 0, balance = -3.
    expect(user.receivedTotal).toBe(0);
    expect(user.balance).toBe(-3);
  });
});

test("idempotent on duplicate message_deleted events", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_G", name: "G", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: ALLOWANCE });

    await executeGive(db, {
      giverId: "U_G", giverDecrement: 1,
      transactions: [{
        toUserId: "U_R", fromUserId: "U_G", amount: 1,
        slackEventId: "EvIdem-0", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
      }],
    });

    const first = await executeMessageReversal(db, {
      channelId: CHANNEL, messageTs: TS, dailyAllowance: ALLOWANCE,
    });
    expect(first.kind).toBe("ok");

    const second = await executeMessageReversal(db, {
      channelId: CHANNEL, messageTs: TS, dailyAllowance: ALLOWANCE,
    });
    expect(second.kind).toBe("noop");

    const [g] = await db.select().from(users).where(eq(users.id, "U_G"));
    const [r] = await db.select().from(users).where(eq(users.id, "U_R"));
    expect(g.dailyRemaining).toBe(ALLOWANCE);
    expect(r.balance).toBe(0);
    expect(r.receivedTotal).toBe(0);

    const reversals = await db.select().from(transactions).where(eq(transactions.type, "reversal"));
    expect(reversals).toHaveLength(1);
  });
});

test("noop when no give matches the (channel, message_ts)", async () => {
  await withCleanDb(async (db) => {
    const result = await executeMessageReversal(db, {
      channelId: CHANNEL, messageTs: "9999.999", dailyAllowance: ALLOWANCE,
    });
    expect(result.kind).toBe("noop");

    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(0);
  });
});

test("reverses both text-mention gives and reaction gives on the same message", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_G", name: "G", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_X", name: "X", dailyAllowance: ALLOWANCE });

    // U_G's text-mention give to U_R.
    await executeGive(db, {
      giverId: "U_G", giverDecrement: 2,
      transactions: [{
        toUserId: "U_R", fromUserId: "U_G", amount: 2,
        slackEventId: "EvMix-0", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
      }],
    });
    // U_X reacts with :taco:, which credits U_G (the message author).
    await executeGive(db, {
      giverId: "U_X", giverDecrement: 1,
      transactions: [{
        toUserId: "U_G", fromUserId: "U_X", amount: 1,
        slackEventId: `react-${CHANNEL}-${TS}-U_X-0`, slackChannelId: CHANNEL, slackMessageTs: TS, reason: "reaction",
      }],
    });

    const result = await executeMessageReversal(db, {
      channelId: CHANNEL, messageTs: TS, dailyAllowance: ALLOWANCE,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.reversed).toHaveLength(2);
      const givers = result.reversed.map((r) => r.giverId).sort();
      expect(givers).toEqual(["U_G", "U_X"]);
    }

    const [g] = await db.select().from(users).where(eq(users.id, "U_G"));
    const [r] = await db.select().from(users).where(eq(users.id, "U_R"));
    const [x] = await db.select().from(users).where(eq(users.id, "U_X"));
    expect(g.dailyRemaining).toBe(ALLOWANCE);
    expect(g.balance).toBe(0); // received 1, reversed
    expect(r.balance).toBe(0); // received 2, reversed
    expect(x.dailyRemaining).toBe(ALLOWANCE); // restored
  });
});

test("partial reversal via UNIQUE: only newly-eligible gives are compensated", async () => {
  // Simulate: a give was inserted twice manually with one already reversed.
  // This proves the per-row UNIQUE on reversedTransactionId blocks the
  // already-reversed row while still applying the unreversed one.
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_G", name: "G", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_S", name: "S", dailyAllowance: ALLOWANCE });

    await executeGive(db, {
      giverId: "U_G", giverDecrement: 1,
      transactions: [{
        toUserId: "U_R", fromUserId: "U_G", amount: 1,
        slackEventId: "EvPartial-G", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
      }],
    });
    await executeGive(db, {
      giverId: "U_S", giverDecrement: 1,
      transactions: [{
        toUserId: "U_R", fromUserId: "U_S", amount: 1,
        slackEventId: `react-${CHANNEL}-${TS}-U_S-0`, slackChannelId: CHANNEL, slackMessageTs: TS, reason: "reaction",
      }],
    });

    // First pass reverses everything.
    const first = await executeMessageReversal(db, {
      channelId: CHANNEL, messageTs: TS, dailyAllowance: ALLOWANCE,
    });
    expect(first.kind).toBe("ok");
    if (first.kind === "ok") expect(first.reversed).toHaveLength(2);

    // A new give arrives for the same (channel, ts) — re-react after delete
    // is already blocked by the existing slackEventId UNIQUE; this test uses
    // a fresh slackEventId to simulate a hypothetical late-arriving event.
    await executeGive(db, {
      giverId: "U_S", giverDecrement: 1,
      transactions: [{
        toUserId: "U_R", fromUserId: "U_S", amount: 1,
        slackEventId: "EvPartial-Late", slackChannelId: CHANNEL, slackMessageTs: TS, reason: "late",
      }],
    });

    const second = await executeMessageReversal(db, {
      channelId: CHANNEL, messageTs: TS, dailyAllowance: ALLOWANCE,
    });
    expect(second.kind).toBe("ok");
    if (second.kind === "ok") expect(second.reversed).toHaveLength(1);

    // Three gives, three reversals total. Each give's row referenced exactly once.
    const reversals = await db.select().from(transactions).where(eq(transactions.type, "reversal"));
    expect(reversals).toHaveLength(3);
    const reversedIds = new Set(reversals.map((r) => r.reversedTransactionId));
    expect(reversedIds.size).toBe(3);
  });
});

test("reversal row has slack_event_id 'delete-<original.id>' for traceability", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_G", name: "G", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: ALLOWANCE });

    await executeGive(db, {
      giverId: "U_G", giverDecrement: 1,
      transactions: [{
        toUserId: "U_R", fromUserId: "U_G", amount: 1,
        slackEventId: "EvTrace-0", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
      }],
    });

    const [give] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.type, "give"), eq(transactions.slackEventId, "EvTrace-0")));

    await executeMessageReversal(db, {
      channelId: CHANNEL, messageTs: TS, dailyAllowance: ALLOWANCE,
    });

    const [reversal] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.type, "reversal"));
    expect(reversal.slackEventId).toBe(`delete-${give.id}`);
    expect(reversal.reversedTransactionId).toBe(give.id);
    expect(reversal.slackChannelId).toBe(CHANNEL);
    expect(reversal.slackMessageTs).toBe(TS);
  });
});

afterAll(async () => closePool());
