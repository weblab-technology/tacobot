import { db } from "@/lib/db/client";
import { config } from "@/lib/config";
import { resetDailyAllowance } from "@/app/api/cron/reset-allowance/reset";

// Manual trigger of the same reset function the daily cron calls. Useful
// when the cron path is unavailable (no CRON_SECRET, broken deploy) or
// when an out-of-cycle reset is needed (e.g. just after a bulk admin
// adjustment that left users with depleted dailyRemaining).
//
// Honors TACO_DAILY_ALLOWANCE from env (default 5) — keep .env.local in
// sync with prod or pass it inline.

async function main() {
  const allowance = config.taco.dailyAllowance;
  const updated = await resetDailyAllowance(db, allowance);
  console.log(`reset-allowance: ${updated} active users reset to ${allowance}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
