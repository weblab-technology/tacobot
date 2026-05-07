import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db/client";
import { items, transactions, users } from "@/lib/db/schema";

// One-shot snapshot: dumps every user, item, and transaction row to a
// timestamped JSON file under `snapshots/`. Used as a recoverable backup
// before the GA balance reset. Restore manually with psql or a follow-up
// script if rollback is ever needed — the dump preserves exact column
// values including signed integers and timestamps.

async function main() {
  const [allUsers, allItems, allTransactions] = await Promise.all([
    db.select().from(users),
    db.select().from(items),
    db.select().from(transactions),
  ]);

  const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "Z");
  const dir = join(process.cwd(), "snapshots");
  const path = join(dir, `tacobot-${stamp}.json`);

  await mkdir(dir, { recursive: true });
  await writeFile(
    path,
    JSON.stringify(
      {
        snapshotAt: new Date().toISOString(),
        counts: {
          users: allUsers.length,
          items: allItems.length,
          transactions: allTransactions.length,
        },
        users: allUsers,
        items: allItems,
        transactions: allTransactions,
      },
      null,
      2,
    ),
  );

  console.log(
    `snapshot-db: wrote ${path} ` +
      `(users=${allUsers.length}, items=${allItems.length}, transactions=${allTransactions.length})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
