import type { App } from "@slack/bolt";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

const COMMAND_RE = {
  score: /\b(score|ranking|leaderboard)\b/i,
  left: /\b(left|how many|how much|combien)\b/i,
  balance: /\b(balance|wallet)\b/i,
  shop: /\b(shop|boutique)\b/i,
  help: /\b(help|aide|commandes)\b/i,
} as const;

async function topReceivers(limit = 5) {
  return db
    .select({ name: users.name, received: users.receivedTotal })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(desc(users.receivedTotal))
    .limit(limit);
}

function formatScore(rows: { name: string; received: number }[]): string {
  if (rows.length === 0) return "🌮 No tacos given yet — be the first!";
  const lines = rows.map((r, i) => `${i + 1}. ${r.name} — ${r.received} 🌮`);
  return ["*Top taco receivers (lifetime)*", ...lines].join("\n");
}

async function dispatch(text: string, _userId: string): Promise<string | null> {
  const t = text.trim();
  if (COMMAND_RE.score.test(t)) {
    const rows = await topReceivers();
    return formatScore(rows);
  }
  // Other commands added in Task 27.
  return null;
}

export function registerCommandHandlers(app: App) {
  app.event("app_mention", async ({ event, client }) => {
    const reply = await dispatch(event.text, event.user ?? "");
    if (reply) {
      await client.chat.postMessage({
        channel: event.channel,
        text: reply,
        thread_ts: event.thread_ts ?? event.ts,
      });
    }
  });

  app.event("message", async ({ event, client }) => {
    if (event.channel_type !== "im") return;
    if ("subtype" in event && (event.subtype === "message_changed" || event.subtype === "message_deleted")) {
      return;
    }
    if (event.subtype === "bot_message") return;
    const text = "text" in event ? (event.text ?? "") : "";
    const userId = "user" in event ? event.user : undefined;
    if (!userId) return;
    const reply = await dispatch(text, userId);
    if (reply) await client.chat.postMessage({ channel: event.channel, text: reply });
  });
}

// Export internals for tests; keep them out of the public-API surface.
export const __test = { dispatch, COMMAND_RE };
