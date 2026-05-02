import { describe, expect, test } from "vitest";
import { findUserIds } from "@/lib/slack/parser";

describe("findUserIds", () => {
  test("returns empty array for no mentions", () => {
    expect(findUserIds("hello world")).toEqual([]);
  });

  test("extracts a single <@U…> mention", () => {
    expect(findUserIds("<@U0123ABC>")).toEqual(["U0123ABC"]);
  });

  test("extracts multiple distinct mentions", () => {
    expect(findUserIds("<@U0123ABC> and <@U0456DEF>")).toEqual([
      "U0123ABC",
      "U0456DEF",
    ]);
  });

  test("handles <@U…|displayname> form", () => {
    expect(findUserIds("<@U0123ABC|alex>")).toEqual(["U0123ABC"]);
  });

  test("deduplicates repeat mentions", () => {
    expect(findUserIds("<@U0123ABC> hi <@U0123ABC|alex>")).toEqual(["U0123ABC"]);
  });

  test("ignores team mentions like <!channel> or <!here>", () => {
    expect(findUserIds("<!channel> <@U0123ABC> <!here>")).toEqual(["U0123ABC"]);
  });

  test("supports W-prefixed enterprise grid IDs", () => {
    expect(findUserIds("<@W0123ABC>")).toEqual(["W0123ABC"]);
  });
});
