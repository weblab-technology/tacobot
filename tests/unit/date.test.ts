import { describe, expect, test } from "vitest";
import { formatDayHeading, formatTimeOfDay, localDayKey } from "@/lib/date";

describe("formatDayHeading", () => {
  test.each([
    [1, "st"],
    [2, "nd"],
    [3, "rd"],
    [4, "th"],
    [10, "th"],
    [11, "th"],
    [12, "th"],
    [13, "th"],
    [21, "st"],
    [22, "nd"],
    [23, "rd"],
    [24, "th"],
    [31, "st"],
  ])("appends correct suffix for %i", (day, suffix) => {
    const d = new Date(2026, 4, day);
    expect(formatDayHeading(d).endsWith(suffix)).toBe(true);
  });

  test("uses month long name and day number", () => {
    const d = new Date(2026, 4, 1);
    expect(formatDayHeading(d)).toBe("May 1st");
  });

  test("formats April 30 as 'April 30th'", () => {
    const d = new Date(2026, 3, 30);
    expect(formatDayHeading(d)).toBe("April 30th");
  });
});

describe("formatTimeOfDay", () => {
  test("renders en-US 12h clock with AM/PM", () => {
    const d = new Date(2026, 4, 1, 16, 2);
    expect(formatTimeOfDay(d)).toBe("4:02 PM");
  });
});

describe("localDayKey", () => {
  test("returns YYYY-MM-DD for the local day", () => {
    const d = new Date(2026, 4, 1, 23, 59);
    expect(localDayKey(d)).toBe("2026-05-01");
  });
});
