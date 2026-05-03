import { describe, expect, test } from "vitest";
import {
  giveSuccessGiverMessage,
  giveSuccessRecipientMessage,
  overAllowanceMessage,
} from "@/lib/slack/format";
import type { GivePlan } from "@/lib/slack/give";

function plan(
  giverId: string,
  recipients: { id: string; amount: number }[],
): GivePlan {
  return {
    giverId,
    giverDecrement: recipients.reduce((s, r) => s + r.amount, 0),
    transactions: recipients.map((r, idx) => ({
      toUserId: r.id,
      fromUserId: giverId,
      amount: r.amount,
      slackEventId: `evt-${idx}`,
      slackChannelId: "C_TAQ",
      slackMessageTs: "1.0",
      reason: null,
    })),
  };
}

describe("giveSuccessGiverMessage", () => {
  test("single recipient, 1 taco, 4 left (singular for both)", () => {
    const p = plan("U_GIVER", [{ id: "U_R", amount: 1 }]);
    expect(giveSuccessGiverMessage(p, 4)).toBe(
      "<@U_R> received 1 taco from you.\nYou have 4 tacos left to give out today.",
    );
  });

  test("single recipient, 3 tacos, 1 left (plural / singular)", () => {
    const p = plan("U_GIVER", [{ id: "U_R", amount: 3 }]);
    expect(giveSuccessGiverMessage(p, 1)).toBe(
      "<@U_R> received 3 tacos from you.\nYou have 1 taco left to give out today.",
    );
  });

  test("drained allowance reads '0 tacos left'", () => {
    const p = plan("U_GIVER", [{ id: "U_R", amount: 5 }]);
    expect(giveSuccessGiverMessage(p, 0)).toBe(
      "<@U_R> received 5 tacos from you.\nYou have 0 tacos left to give out today.",
    );
  });

  test("multi recipient: one line per recipient + footer", () => {
    const p = plan("U_GIVER", [
      { id: "U_A", amount: 2 },
      { id: "U_B", amount: 2 },
    ]);
    expect(giveSuccessGiverMessage(p, 1)).toBe(
      "<@U_A> received 2 tacos from you.\n<@U_B> received 2 tacos from you.\nYou have 1 taco left to give out today.",
    );
  });
});

describe("giveSuccessRecipientMessage", () => {
  test("1 taco — singular", () => {
    expect(giveSuccessRecipientMessage("U_GIVER", 1, "C_TAQ")).toBe(
      "You received 1 taco from <@U_GIVER> in <#C_TAQ>.",
    );
  });

  test("3 tacos — plural", () => {
    expect(giveSuccessRecipientMessage("U_GIVER", 3, "C_TAQ")).toBe(
      "You received 3 tacos from <@U_GIVER> in <#C_TAQ>.",
    );
  });
});

describe("overAllowanceMessage", () => {
  test("renders demand and remaining with plural", () => {
    expect(overAllowanceMessage(3, 2)).toContain("only got 2 tacos left");
    expect(overAllowanceMessage(3, 2)).toContain("would need 3");
  });

  test("singular when 1 remains", () => {
    expect(overAllowanceMessage(3, 1)).toContain("only got 1 taco left");
  });
});
