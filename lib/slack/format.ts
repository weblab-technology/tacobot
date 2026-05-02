export function overAllowanceMessage(demand: number, remaining: number): string {
  return `🌮 You've only got ${remaining} taco${remaining === 1 ? "" : "s"} left today; that would need ${demand}. Try again tomorrow.`;
}
