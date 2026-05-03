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
