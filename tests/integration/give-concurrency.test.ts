import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, withCleanDb } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { executeGive } from "@/lib/slack/execute";
import { users, transactions } from "@/lib/db/schema";

test("two parallel gives totaling more than allowance: only the fitting one succeeds", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_G", name: "G", dailyAllowance: 1 });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_B", name: "B", dailyAllowance: 5 });

    const planA = {
      giverId: "U_G",
      giverDecrement: 1,
      transactions: [
        {
          toUserId: "U_A",
          fromUserId: "U_G",
          amount: 1,
          slackEventId: "EvA-0",
          slackChannelId: "C",
          slackMessageTs: "A",
          reason: null,
        },
      ],
    };
    const planB = {
      giverId: "U_G",
      giverDecrement: 1,
      transactions: [
        {
          toUserId: "U_B",
          fromUserId: "U_G",
          amount: 1,
          slackEventId: "EvB-0",
          slackChannelId: "C",
          slackMessageTs: "B",
          reason: null,
        },
      ],
    };

    const [resA, resB] = await Promise.all([
      executeGive(db, planA),
      executeGive(db, planB),
    ]);

    const successes = [resA, resB].filter((r) => r.kind === "ok").length;
    const overs = [resA, resB].filter((r) => r.kind === "over_allowance").length;
    expect(successes).toBe(1);
    expect(overs).toBe(1);

    const [g] = await db.select().from(users).where(eq(users.id, "U_G"));
    expect(g.dailyRemaining).toBe(0);

    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(1);
  });
});

afterAll(async () => {
  await closePool();
});
