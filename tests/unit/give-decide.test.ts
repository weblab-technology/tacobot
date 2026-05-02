import { describe, expect, test } from "vitest";
import { decide } from "@/lib/slack/give";

describe("decide", () => {
  test("produces one row per recipient with correct amount", () => {
    const plan = decide({
      giverId: "U_G",
      recipients: ["U_A", "U_B"],
      perRecipient: 2,
      totalDemand: 4,
      channelId: "C",
      channelTs: "1700.0",
      envelopeEventId: "Ev42",
    });
    expect(plan.giverDecrement).toBe(4);
    expect(plan.transactions).toHaveLength(2);
    expect(plan.transactions[0]).toMatchObject({
      toUserId: "U_A",
      fromUserId: "U_G",
      amount: 2,
      slackEventId: "Ev42-0",
    });
    expect(plan.transactions[1]).toMatchObject({
      toUserId: "U_B",
      slackEventId: "Ev42-1",
    });
  });

  test("preserves recipient order so the index is stable", () => {
    const plan = decide({
      giverId: "U_G",
      recipients: ["U_A", "U_B", "U_C"],
      perRecipient: 1,
      totalDemand: 3,
      channelId: "C",
      channelTs: "1.0",
      envelopeEventId: "Ev",
    });
    expect(plan.transactions.map((t) => t.slackEventId)).toEqual(["Ev-0", "Ev-1", "Ev-2"]);
  });
});
