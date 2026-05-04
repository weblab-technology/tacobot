import { describe, expect, test } from "vitest";
import {
  giveSuccessGiverMessage,
  giveSuccessRecipientMessage,
  messageDeletedGiverMessage,
  messageDeletedRecipientMessage,
  overAllowanceMessage,
  reactionRemovedReactorMessage,
  reactionRemovedRecipientMessage,
} from "@/lib/slack/format";
import type { GivePlan } from "@/lib/slack/give";
import type { ReversedItem } from "@/lib/slack/reverse";

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

function reversed(items: { giver: string; recipient: string; amount: number }[]): ReversedItem[] {
  return items.map((i, idx) => ({
    giverId: i.giver,
    recipientId: i.recipient,
    amount: i.amount,
    originalTransactionId: `tx-${idx}`,
  }));
}

describe("messageDeletedGiverMessage", () => {
  test("uses neutral wording — works for the deleter AND for reactors caught in the wash", () => {
    expect(messageDeletedGiverMessage(
      reversed([{ giver: "U_G", recipient: "U_R", amount: 1 }]),
      "C_TAQ",
    )).toBe(
      "🌮 A message in <#C_TAQ> was deleted; the tacos you gave in connection with it were taken back:\n<@U_R> lost 1 taco.",
    );
  });

  test("multiple recipients with mixed amounts", () => {
    expect(
      messageDeletedGiverMessage(
        reversed([
          { giver: "U_G", recipient: "U_A", amount: 2 },
          { giver: "U_G", recipient: "U_B", amount: 3 },
        ]),
        "C_TAQ",
      ),
    ).toBe(
      "🌮 A message in <#C_TAQ> was deleted; the tacos you gave in connection with it were taken back:\n<@U_A> lost 2 tacos.\n<@U_B> lost 3 tacos.",
    );
  });
});

describe("messageDeletedRecipientMessage", () => {
  test("singular phrasing for 1 taco — neutral about who deleted", () => {
    expect(messageDeletedRecipientMessage("U_G", 1, "C_TAQ")).toBe(
      "🌮 A message in <#C_TAQ> was deleted; 1 taco you received from <@U_G> was taken back.",
    );
  });

  test("plural phrasing for >1 tacos", () => {
    expect(messageDeletedRecipientMessage("U_G", 4, "C_TAQ")).toBe(
      "🌮 A message in <#C_TAQ> was deleted; 4 tacos you received from <@U_G> were taken back.",
    );
  });
});

describe("reactionRemovedReactorMessage", () => {
  test("single recipient, 1 taco — singular", () => {
    expect(reactionRemovedReactorMessage([{ recipientId: "U_R", amount: 1 }], "C_TAQ")).toBe(
      "🌮 You removed your :taco: reaction in <#C_TAQ>; 1 taco was taken back from <@U_R>.",
    );
  });

  test("single recipient, >1 tacos — plural", () => {
    expect(reactionRemovedReactorMessage([{ recipientId: "U_R", amount: 2 }], "C_TAQ")).toBe(
      "🌮 You removed your :taco: reaction in <#C_TAQ>; 2 tacos were taken back from <@U_R>.",
    );
  });

  test("multi-recipient: header + one line per recipient", () => {
    expect(
      reactionRemovedReactorMessage(
        [
          { recipientId: "U_A", amount: 1 },
          { recipientId: "U_B", amount: 1 },
        ],
        "C_TAQ",
      ),
    ).toBe(
      "🌮 You removed your :taco: reaction in <#C_TAQ>; reversed:\n<@U_A> lost 1 taco.\n<@U_B> lost 1 taco.",
    );
  });
});

describe("reactionRemovedRecipientMessage", () => {
  test("singular phrasing for 1 taco", () => {
    expect(reactionRemovedRecipientMessage("U_REACT", 1, "C_TAQ")).toBe(
      "🌮 <@U_REACT> removed their :taco: reaction in <#C_TAQ>; 1 taco you received from them was taken back.",
    );
  });

  test("plural phrasing for >1 tacos", () => {
    expect(reactionRemovedRecipientMessage("U_REACT", 3, "C_TAQ")).toBe(
      "🌮 <@U_REACT> removed their :taco: reaction in <#C_TAQ>; 3 tacos you received from them were taken back.",
    );
  });
});
