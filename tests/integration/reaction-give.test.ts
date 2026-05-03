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

test("reaction falls back to message author when no @-mention", async () => {
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

test("reaction credits mentioned user instead of author when message has @-mention", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "UREACT", name: "R", dailyAllowance: 5 });
    await upsertUser(db, { id: "UAUTHOR", name: "A", dailyAllowance: 5 });
    await upsertUser(db, { id: "URECIP", name: "Recip", dailyAllowance: 5 });

    const out = await processReaction(db, {
      reactor: "UREACT",
      author: "UAUTHOR",
      channelId: "C_TAQ",
      messageTs: "1700.0",
      messageText: "<@URECIP> :taco: :taco:",
    });

    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.plan.giverDecrement).toBe(1);
      expect(out.plan.transactions).toHaveLength(1);
      expect(out.plan.transactions[0]).toMatchObject({
        toUserId: "URECIP",
        fromUserId: "UREACT",
        amount: 1,
      });
    }
    const [recip] = await db.select().from(users).where(eq(users.id, "URECIP"));
    expect(recip.balance).toBe(1);
    const [author] = await db.select().from(users).where(eq(users.id, "UAUTHOR"));
    expect(author.balance).toBe(0);
  });
});

test("reaction credits multiple mentioned users", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "UREACT", name: "R", dailyAllowance: 5 });
    await upsertUser(db, { id: "UAUTHOR", name: "A", dailyAllowance: 5 });
    await upsertUser(db, { id: "UX", name: "X", dailyAllowance: 5 });
    await upsertUser(db, { id: "UY", name: "Y", dailyAllowance: 5 });

    const out = await processReaction(db, {
      reactor: "UREACT",
      author: "UAUTHOR",
      channelId: "C_TAQ",
      messageTs: "1700.0",
      messageText: "<@UX> <@UY> :taco:",
    });

    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.plan.giverDecrement).toBe(2);
      expect(out.plan.transactions).toHaveLength(2);
      const recipients = out.plan.transactions.map((t) => t.toUserId).sort();
      expect(recipients).toEqual(["UX", "UY"]);
      const eventIds = out.plan.transactions.map((t) => t.slackEventId).sort();
      expect(eventIds).toEqual([
        "react-C_TAQ-1700.0-UREACT-0",
        "react-C_TAQ-1700.0-UREACT-1",
      ]);
    }
    const [x] = await db.select().from(users).where(eq(users.id, "UX"));
    const [y] = await db.select().from(users).where(eq(users.id, "UY"));
    expect(x.balance).toBe(1);
    expect(y.balance).toBe(1);
    const [a] = await db.select().from(users).where(eq(users.id, "UAUTHOR"));
    expect(a.balance).toBe(0);
  });
});

test("reaction filters out the reactor from mentioned recipients", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "UREACT", name: "R", dailyAllowance: 5 });
    await upsertUser(db, { id: "UAUTHOR", name: "A", dailyAllowance: 5 });
    await upsertUser(db, { id: "UOTHER", name: "Other", dailyAllowance: 5 });

    const out = await processReaction(db, {
      reactor: "UREACT",
      author: "UAUTHOR",
      channelId: "C_TAQ",
      messageTs: "1700.0",
      messageText: "<@UREACT> <@UOTHER> :taco:",
    });

    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.plan.transactions).toHaveLength(1);
      expect(out.plan.transactions[0].toUserId).toBe("UOTHER");
    }
    const [r] = await db.select().from(users).where(eq(users.id, "UREACT"));
    expect(r.balance).toBe(0);
  });
});

test("reaction with only the reactor mentioned is ignored", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "UREACT", name: "R", dailyAllowance: 5 });
    await upsertUser(db, { id: "UAUTHOR", name: "A", dailyAllowance: 5 });

    const out = await processReaction(db, {
      reactor: "UREACT",
      author: "UAUTHOR",
      channelId: "C_TAQ",
      messageTs: "1700.0",
      messageText: "<@UREACT> :taco:",
    });

    expect(out.kind).toBe("ignore");
    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(0);
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
