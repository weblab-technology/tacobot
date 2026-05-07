import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { grant } from "@/lib/admin/grant";

// One-shot GA reset: zero every user's `balance` by issuing a signed `grant`.
//
// Notes:
// - `grant()` decrements both `balance` and `receivedTotal` by the same delta
//   (lib/admin/grant.ts), so users who already redeemed will end up with a
//   non-zero `receivedTotal` afterwards. That's intentional — receivedTotal
//   tracks lifetime giving and the redemptions stay in the ledger.
// - `dailyRemaining` is not touched. The 00:00 UTC cron handles that; run
//   this script after the cron fires.
// - Set DRY_RUN=1 to preview without writing.
// - RESET_ADMIN_SLACK_ID must be a real Slack user ID (the admin accountable
//   for the reset). The grant CHECK constraint requires it.

async function main() {
  const adminId = process.env.RESET_ADMIN_SLACK_ID;
  if (!adminId) {
    throw new Error("RESET_ADMIN_SLACK_ID is required (Slack ID of the admin issuing the reset)");
  }

  const dryRun = process.env.DRY_RUN === "1";
  const reason = process.env.RESET_REASON ?? "GA reset: zeroing beta balances";

  const all = await db.select().from(users);
  const targets = all.filter((u) => u.balance !== 0);

  console.log(
    `zero-balances: ${all.length} users total, ${targets.length} non-zero balances` +
      (dryRun ? " [DRY RUN]" : ""),
  );

  let total = 0;
  for (const u of targets) {
    const delta = -u.balance;
    console.log(
      `  ${u.id} (${u.name}): balance ${u.balance} → 0  ` +
        `[receivedTotal ${u.receivedTotal} → ${u.receivedTotal + delta}]`,
    );
    total += Math.abs(delta);
    if (!dryRun) {
      await grant(db, { recipientId: u.id, amount: delta, adminId, reason });
    }
  }

  console.log(
    `zero-balances: ${dryRun ? "would adjust" : "adjusted"} ${targets.length} users, ` +
      `${total} total tacos moved`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
