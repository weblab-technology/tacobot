import type { App } from "@slack/bolt";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { upsertUser } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";
import { config } from "@/lib/config";

function pickName(u: {
  profile?: { display_name?: string; real_name?: string };
  name?: string;
}): string {
  const dn = u.profile?.display_name?.trim();
  if (dn) return dn;
  const rn = u.profile?.real_name?.trim();
  if (rn) return rn;
  return u.name ?? "unknown";
}

export function registerUserSyncHandlers(app: App) {
  app.event("team_join", async ({ event }) => {
    const u = event.user;
    if (!u || u.is_bot || u.deleted) return;
    await upsertUser(db, {
      id: u.id,
      name: pickName(u),
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
      name: pickName(u),
      dailyAllowance: config.taco.dailyAllowance,
    });
  });
}
