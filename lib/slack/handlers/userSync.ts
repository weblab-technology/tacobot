import type { App } from "@slack/bolt";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { upsertUser } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";
import { config } from "@/lib/config";
import { pickName } from "@/lib/slack/userInfo";

function nameOrFallback(u: Parameters<typeof pickName>[0]): string {
  return pickName(u) ?? "unknown";
}

export function registerUserSyncHandlers(app: App) {
  app.event("team_join", async ({ event }) => {
    const u = event.user;
    if (!u || u.is_bot || u.deleted) return;
    await upsertUser(db, {
      id: u.id,
      name: nameOrFallback(u),
      dailyAllowance: config.taco.dailyAllowance,
    });
  });

  app.event("user_change", async ({ event }) => {
    const u = event.user;
    if (!u) return;
    if (u.is_bot) return;

    if (u.deleted) {
      await db.update(users).set({ isActive: false }).where(eq(users.id, u.id));
      return;
    }
    await upsertUser(db, {
      id: u.id,
      name: nameOrFallback(u),
      dailyAllowance: config.taco.dailyAllowance,
    });
  });
}
