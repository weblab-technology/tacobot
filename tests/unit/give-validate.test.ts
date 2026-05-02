import { describe, expect, test } from "vitest";
import { validate, type Intent, type GiverState } from "@/lib/slack/give";

const config = {
  channels: ["C_TAQ"],
  dailyAllowance: 5,
};

const giver: GiverState = {
  id: "U_GIVER",
  isActive: true,
  dailyRemaining: 5,
};

const baseIntent: Intent = {
  giverId: "U_GIVER",
  recipientIds: ["U_BOB"],
  tacoCount: 1,
  channelId: "C_TAQ",
  slackEventId: "Ev1",
  channelTs: "1700000000.0",
};

describe("validate", () => {
  test("accepts a typical single-recipient give", () => {
    const r = validate(baseIntent, giver, config);
    expect(r.kind).toBe("ok");
  });

  test("rejects when channel is not in allowlist", () => {
    const r = validate({ ...baseIntent, channelId: "C_OTHER" }, giver, config);
    expect(r.kind).toBe("ignore");
    if (r.kind === "ignore") expect(r.reason).toBe("channel_not_allowlisted");
  });

  test("ignores when zero tacos", () => {
    const r = validate({ ...baseIntent, tacoCount: 0 }, giver, config);
    expect(r.kind).toBe("ignore");
  });

  test("ignores when no recipients", () => {
    const r = validate({ ...baseIntent, recipientIds: [] }, giver, config);
    expect(r.kind).toBe("ignore");
  });

  test("rejects giver who is inactive", () => {
    const r = validate(baseIntent, { ...giver, isActive: false }, config);
    expect(r.kind).toBe("ignore");
    if (r.kind === "ignore") expect(r.reason).toBe("giver_inactive");
  });

  test("rejects when total demand exceeds allowance", () => {
    const r = validate({ ...baseIntent, tacoCount: 6 }, giver, config);
    expect(r.kind).toBe("over_allowance");
    if (r.kind === "over_allowance") {
      expect(r.demand).toBe(6);
      expect(r.remaining).toBe(5);
    }
  });

  test("strips self-mention from recipients", () => {
    const r = validate(
      { ...baseIntent, recipientIds: ["U_GIVER", "U_BOB"] },
      giver,
      config,
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.recipients).toEqual(["U_BOB"]);
  });

  test("ignores if all recipients filtered out (only self)", () => {
    const r = validate({ ...baseIntent, recipientIds: ["U_GIVER"] }, giver, config);
    expect(r.kind).toBe("ignore");
  });

  test("computes total demand as count × recipients", () => {
    const r = validate(
      { ...baseIntent, recipientIds: ["U_BOB", "U_CAROL"], tacoCount: 2 },
      { ...giver, dailyRemaining: 5 },
      config,
    );
    // 2 × 2 = 4, fits in 5 → ok
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.totalDemand).toBe(4);
  });

  test("sorts recipients ascending for stable event ID", () => {
    const r = validate(
      { ...baseIntent, recipientIds: ["U_C", "U_A", "U_B"] },
      giver,
      config,
    );
    if (r.kind === "ok") expect(r.recipients).toEqual(["U_A", "U_B", "U_C"]);
  });
});
