import { describe, expect, test } from "vitest";
import { periodStart } from "@/lib/date";

describe("periodStart", () => {
  test("returns null for 'all'", () => {
    expect(periodStart("all", new Date("2026-05-04T12:00:00Z"))).toBeNull();
  });

  test("returns today 00:00 UTC for 'today'", () => {
    const now = new Date("2026-05-04T12:34:56Z");
    expect(periodStart("today", now)?.toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });

  test("returns same Monday 00:00 UTC when 'now' is on Monday", () => {
    // 2026-05-04 is a Monday
    const monday = new Date("2026-05-04T15:00:00Z");
    expect(periodStart("week", monday)?.toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });

  test("returns previous Monday for 'week' when 'now' is Sunday", () => {
    // 2026-05-10 is a Sunday; previous Monday is 2026-05-04
    const sunday = new Date("2026-05-10T23:59:00Z");
    expect(periodStart("week", sunday)?.toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });

  test("returns previous Monday for 'week' when 'now' is mid-week", () => {
    // 2026-05-07 is a Thursday; current week's Monday is 2026-05-04
    const thursday = new Date("2026-05-07T08:00:00Z");
    expect(periodStart("week", thursday)?.toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });

  test("returns first of month 00:00 UTC for 'month'", () => {
    const now = new Date("2026-05-15T08:00:00Z");
    expect(periodStart("month", now)?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  test("month boundary: midnight UTC on the 1st returns same day", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    expect(periodStart("month", now)?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});
