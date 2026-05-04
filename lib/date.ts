/**
 * Format a Date as a day heading like "May 1st" or "April 23rd". Uses the
 * runtime's local time zone so operators see headings aligned with their day.
 */
export function formatDayHeading(d: Date): string {
  const month = new Intl.DateTimeFormat("en-US", { month: "long" }).format(d);
  const day = d.getDate();
  return `${month} ${day}${ordinalSuffix(day)}`;
}

/**
 * Format a Date as a clock label like "4:02 PM".
 */
export function formatTimeOfDay(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/**
 * "yyyy-mm-dd" key used to detect day boundaries in a sorted list. Local time
 * to match formatDayHeading.
 */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type LeaderboardPeriod = "all" | "today" | "week" | "month";

/**
 * Lower-bound Date (inclusive) for a leaderboard period, or null for "all".
 * Boundaries are computed in UTC so they align with the bot's daily reset.
 * Week starts Monday (ISO week).
 */
export function periodStart(period: LeaderboardPeriod, now: Date): Date | null {
  if (period === "all") return null;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === "today") return new Date(Date.UTC(y, m, d));
  if (period === "month") return new Date(Date.UTC(y, m, 1));
  // week — most recent Monday 00:00 UTC. JS getUTCDay: Sun=0..Sat=6.
  // Days to subtract so we land on Monday: Sun→6, Mon→0, Tue→1, ...
  const dow = now.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  return new Date(Date.UTC(y, m, d - daysSinceMonday));
}

function ordinalSuffix(n: number): string {
  // 11–13 are always "th" regardless of last digit.
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
