import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { transactions } from "@/lib/db/schema";

// One-shot: hard-delete every transaction tagged to a given Slack channel.
// Use to scrub beta-era give/reversal history after GA cutover.
//
// Skipped by design: rows where slack_channel_id IS NULL (grants, redeems,
// admin adjustments). Those are not channel-scoped events.
//
// CONFIRM=1 actually deletes; otherwise this is a dry-run.

async function main() {
  const channelId = process.env.PURGE_CHANNEL_ID;
  if (!channelId) {
    throw new Error("PURGE_CHANNEL_ID is required (Slack channel ID, e.g. C0B19CZNHDK)");
  }
  const confirm = process.env.CONFIRM === "1";

  const rows = await db
    .select({ id: transactions.id, type: transactions.type })
    .from(transactions)
    .where(eq(transactions.slackChannelId, channelId));

  const byType = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.type] = (acc[r.type] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    `purge-channel-history: ${rows.length} rows match channel=${channelId}` +
      (confirm ? "" : " [DRY RUN — set CONFIRM=1 to execute]"),
  );
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type}: ${count}`);
  }

  if (!confirm) return;

  const deleted = await db
    .delete(transactions)
    .where(eq(transactions.slackChannelId, channelId))
    .returning({ id: transactions.id });

  console.log(`purge-channel-history: deleted ${deleted.length} rows`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
