import { WebClient } from "@slack/web-api";
import { eq, notInArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { upsertUser } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";
import { config } from "@/lib/config";

async function main() {
  const client = new WebClient(config.slack.botToken);
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const res = await client.users.list({ limit: 200, cursor });
    pages++;
    if (!res.members) break;
    for (const m of res.members) {
      if (!m.id) continue;
      if (m.is_bot) continue;
      if (m.deleted) {
        await db.update(users).set({ isActive: false }).where(eq(users.id, m.id));
        continue;
      }
      const name =
        m.profile?.display_name?.trim() ||
        m.profile?.real_name?.trim() ||
        m.name ||
        m.id;
      await upsertUser(db, {
        id: m.id,
        name,
        dailyAllowance: config.taco.dailyAllowance,
      });
      seen.push(m.id);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Anyone in DB not seen this run is treated as inactive.
  if (seen.length > 0) {
    await db
      .update(users)
      .set({ isActive: false })
      .where(notInArray(users.id, seen));
  }

  console.log(`sync-users: ${pages} page(s), ${seen.length} active users`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
