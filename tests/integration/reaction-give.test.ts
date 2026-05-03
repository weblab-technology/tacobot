import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { closePool, withCleanDb } from "./helpers/db";
import { processReaction } from "@/lib/slack/handlers/reaction";
import { upsertUser } from "@/lib/db/queries";
import { transactions, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

vi.mock("@/lib/config", () => ({
  config: {
    taco: { channels: ["C_TAQ"], dailyAllowance: 5 },
    slack: { botUserId: "U_BOT", botToken: "xoxb-test", signingSecret: "test" },
    admin: { slackIds: [] },
    shopUrl: "/shop",
    cronSecret: undefined,
  },
}));

vi.mock("@/lib/slack/botUserId", () => ({
  getBotUserId: async () => "U_BOT",
}));

vi.mock("@/lib/slack/userInfo", () => ({
  resolveUserName: async () => null,
  pickName: () => null,
}));

beforeEach(() => vi.clearAllMocks());

test("reaction give credits the message author", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: 5 });

    const out = await processReaction(db, {
      reactor: "U_R", author: "U_A", channelId: "C_TAQ", messageTs: "1700.0",
    });

    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.remainingAfter).toBe(4);
      expect(out.plan.giverDecrement).toBe(1);
      expect(out.plan.transactions).toHaveLength(1);
      expect(out.plan.transactions[0]).toMatchObject({
        toUserId: "U_A",
        fromUserId: "U_R",
        amount: 1,
      });
    }
    const [a] = await db.select().from(users).where(eq(users.id, "U_A"));
    expect(a.balance).toBe(1);

    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(1);
    expect(txns[0].slackEventId).toBe("react-C_TAQ-1700.0-U_R-0");
  });
});

test("self-reaction is ignored", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_X", name: "X", dailyAllowance: 5 });
    const out = await processReaction(db, {
      reactor: "U_X", author: "U_X", channelId: "C_TAQ", messageTs: "1.0",
    });
    expect(out.kind).toBe("ignore");
  });
});

test("reaction stores the reacted-to message text in transactions.reason", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: 5 });

    const out = await processReaction(db, {
      reactor: "U_R",
      author: "U_A",
      channelId: "C_TAQ",
      messageTs: "1700.0",
      messageText: "ship it 🚀",
    });

    expect(out.kind).toBe("ok");
    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(1);
    expect(txns[0].reason).toBe("ship it 🚀");
  });
});

test("reaction with empty message text falls back to literal 'reaction'", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: 5 });

    const out = await processReaction(db, {
      reactor: "U_R",
      author: "U_A",
      channelId: "C_TAQ",
      messageTs: "1700.0",
      messageText: "   ",
    });

    expect(out.kind).toBe("ok");
    const [t] = await db.select().from(transactions);
    expect(t.reason).toBe("reaction");
  });
});

test("reaction outside allowlisted channel is ignored", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: 5 });
    const out = await processReaction(db, {
      reactor: "U_R", author: "U_A", channelId: "C_OTHER", messageTs: "1.0",
    });
    expect(out.kind).toBe("ignore");
  });
});

afterAll(async () => {
  await closePool();
});
