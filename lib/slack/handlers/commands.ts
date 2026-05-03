import type { App } from "@slack/bolt";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { config } from "@/lib/config";

const COMMAND_RE = {
  score: /\b(score|ranking|leaderboard)\b/i,
  left: /\b(left|how many|how much|combien)\b/i,
  balance: /\b(balance|wallet)\b/i,
  shop: /\b(shop|boutique)\b/i,
  help: /\b(help|aide|commandes)\b/i,
} as const;

async function topReceivers(limit = 5) {
  return db
    .select({ id: users.id, received: users.receivedTotal })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(desc(users.receivedTotal))
    .limit(limit);
}

function formatScore(rows: { id: string; received: number }[]): string {
  if (rows.length === 0) return "🌮 No tacos given yet — be the first!";
  // Use <@USERID> mentions; Slack renders these as the user's current display
  // name with avatar, so we don't have to keep our `name` column in sync with
  // profile changes.
  const lines = rows.map((r, i) => `${i + 1}. <@${r.id}> — ${r.received} 🌮`);
  return ["*Top taco receivers (lifetime)*", ...lines].join("\n");
}

const HELP_TEXT = `🌮 *Tacobot commands*
• \`score\`/\`ranking\` — top 5 taco receivers
• \`balance\`/\`wallet\` — what you can spend in the shop
• \`left\`/\`how many\`/\`combien\` — tacos you have left to give today
• \`shop\`/\`boutique\` — shop URL
• \`help\`/\`aide\`/\`commandes\` — this message

To give a taco, type \`@person :taco:\` in #taqueria, or react to their message with 🌮.`;

async function dispatch(text: string, userId: string): Promise<string | null> {
  const t = text.trim();
  if (COMMAND_RE.score.test(t)) {
    const rows = await topReceivers();
    return formatScore(rows);
  }
  if (COMMAND_RE.left.test(t)) {
    const [u] = await db
      .select({ left: users.dailyRemaining })
      .from(users)
      .where(eq(users.id, userId));
    if (!u) return `You have ${config.taco.dailyAllowance} tacos left to give today.`;
    return `You have ${u.left} taco${u.left === 1 ? "" : "s"} left to give today.`;
  }
  if (COMMAND_RE.balance.test(t)) {
    const [u] = await db
      .select({ balance: users.balance })
      .from(users)
      .where(eq(users.id, userId));
    const bal = u?.balance ?? 0;
    return `You have ${bal} taco${bal === 1 ? "" : "s"} to spend. Browse the shop: ${config.shopUrl}`;
  }
  if (COMMAND_RE.shop.test(t)) {
    return `Shop: ${config.shopUrl}`;
  }
  if (COMMAND_RE.help.test(t)) {
    return HELP_TEXT;
  }
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
