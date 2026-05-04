import { afterAll, expect, test } from "vitest";
import { closePool, withCleanDb } from "./helpers/db";
import { upsertUser, countReversalsPerGiveGroup } from "@/lib/db/queries";
import { executeGive } from "@/lib/slack/execute";
import { executeReactionReversal } from "@/lib/slack/reverse";

const ALLOWANCE = 5;
const CHANNEL = "C_TAQ";
const TS = "1700.0";

test("returns 0 for an unreversed give-group", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_G", name: "G", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: ALLOWANCE });

    await executeGive(db, {
      giverId: "U_G", giverDecrement: 1,
      transactions: [{
        toUserId: "U_R", fromUserId: "U_G", amount: 1,
        slackEventId: "Ev-0", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
      }],
    });

    const counts = await countReversalsPerGiveGroup(db, [
      { fromUserId: "U_G", slackChannelId: CHANNEL, slackMessageTs: TS },
    ]);
    expect(counts.get(`U_G|${CHANNEL}|${TS}`)).toBe(0);
  });
});

test("returns the count when fully reversed", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_G", name: "G", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_B", name: "B", dailyAllowance: ALLOWANCE });

    await executeGive(db, {
      giverId: "U_G", giverDecrement: 2,
      transactions: [
        {
          toUserId: "U_A", fromUserId: "U_G", amount: 1,
          slackEventId: "Ev-0", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
        },
        {
          toUserId: "U_B", fromUserId: "U_G", amount: 1,
          slackEventId: "Ev-1", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
        },
      ],
    });
    await executeReactionReversal(db, {
      channelId: CHANNEL, messageTs: TS, reactor: "U_G", dailyAllowance: ALLOWANCE,
    });

    const counts = await countReversalsPerGiveGroup(db, [
      { fromUserId: "U_G", slackChannelId: CHANNEL, slackMessageTs: TS },
    ]);
    expect(counts.get(`U_G|${CHANNEL}|${TS}`)).toBe(2);
  });
});

test("attributes reversals per-giver when multiple givers share (channel, ts)", async () => {
  // BUG-1 regression test. U_AUTHOR posts with `<@U_R> :taco:`; U_X reacts
  // with :taco:. Two distinct give-groups at the same (channel, ts):
  //   #1: (U_AUTHOR → U_R)        — text-mention
  //   #2: (U_X     → U_AUTHOR)    — reaction
  // U_X removes their reaction. Only group #2 should show as reversed —
  // group #1 must stay at 0. The buggy implementation merged both counts
  // and showed group #1 as reversed too.
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_AUTHOR", name: "Author", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: ALLOWANCE });
    await upsertUser(db, { id: "U_X", name: "X", dailyAllowance: ALLOWANCE });

    // Group #1: U_AUTHOR's text-mention give to U_R.
    await executeGive(db, {
      giverId: "U_AUTHOR", giverDecrement: 1,
      transactions: [{
        toUserId: "U_R", fromUserId: "U_AUTHOR", amount: 1,
        slackEventId: "AuthorGive-0", slackChannelId: CHANNEL, slackMessageTs: TS, reason: null,
      }],
    });
    // Group #2: U_X reacts → 1 taco from U_X to U_AUTHOR.
    await executeGive(db, {
      giverId: "U_X", giverDecrement: 1,
      transactions: [{
        toUserId: "U_AUTHOR", fromUserId: "U_X", amount: 1,
        slackEventId: `react-${CHANNEL}-${TS}-U_X-0`,
        slackChannelId: CHANNEL, slackMessageTs: TS, reason: "reaction",
      }],
    });

    // U_X unreacts. Only U_X's give-group is reversed.
    await executeReactionReversal(db, {
      channelId: CHANNEL, messageTs: TS, reactor: "U_X", dailyAllowance: ALLOWANCE,
    });

    const counts = await countReversalsPerGiveGroup(db, [
      { fromUserId: "U_AUTHOR", slackChannelId: CHANNEL, slackMessageTs: TS },
      { fromUserId: "U_X", slackChannelId: CHANNEL, slackMessageTs: TS },
    ]);
    expect(counts.get(`U_AUTHOR|${CHANNEL}|${TS}`)).toBe(0);
    expect(counts.get(`U_X|${CHANNEL}|${TS}`)).toBe(1);
  });
});

test("returns an empty map when given no groups", async () => {
  await withCleanDb(async (db) => {
    const counts = await countReversalsPerGiveGroup(db, []);
    expect(counts.size).toBe(0);
  });
});

afterAll(async () => closePool());
