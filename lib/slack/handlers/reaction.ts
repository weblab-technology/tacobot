import type { App } from "@slack/bolt";
import { db } from "@/lib/db/client";
import { ensureUserExists, upsertUser } from "@/lib/db/queries";
import type { DbLike } from "@/lib/db/types";
import { config } from "@/lib/config";
import { decide, validate, type GiverState, type GivePlan } from "../give";
import { executeGive } from "../execute";
import { executeReactionReversal } from "../reverse";
import { getBotUserId } from "../botUserId";
import { resolveUserName } from "../userInfo";
import { findUserIds } from "../parser";
import {
  giveSuccessGiverMessage,
  giveSuccessRecipientMessage,
  overAllowanceMessage,
  reactionRemovedReactorMessage,
  reactionRemovedRecipientMessage,
} from "../format";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";

export type ReactionInput = {
  reactor: string;
  author: string;
  channelId: string;
  messageTs: string;
  messageText?: string;
};

export type ReactionOutcome =
  | { kind: "ok"; plan: GivePlan; remainingAfter: number }
  | { kind: "ignore"; reason: string }
  | { kind: "over_allowance"; demand: number; remaining: number };

export async function processReaction(database: DbLike, input: ReactionInput): Promise<ReactionOutcome> {
  if (!config.taco.channels.includes(input.channelId)) {
    return { kind: "ignore", reason: "channel_not_allowlisted" };
  }
  const botId = await getBotUserId();
  if (input.author === botId) {
    return { kind: "ignore", reason: "bot_author" };
  }

  // Reactions on a message that mentions users credit the mentioned users
  // (the reactor is endorsing the gift). When no one is mentioned, fall back
  // to crediting the message author. The bot itself is never a recipient.
  const mentioned = findUserIds(input.messageText ?? "").filter((id) => id !== botId);
  const recipientIds = mentioned.length > 0 ? mentioned : [input.author];

  const allKnownIds = [input.reactor, input.author, ...recipientIds];
  const uniqueIds = [...new Set(allKnownIds)];
  for (const id of uniqueIds) {
    await ensureUserExists(database, { id, dailyAllowance: config.taco.dailyAllowance });
  }
  const resolvedNames = await Promise.all(uniqueIds.map((id) => resolveUserName(id)));
  for (let i = 0; i < uniqueIds.length; i++) {
    const name = resolvedNames[i];
    if (name) {
      await upsertUser(database, { id: uniqueIds[i], name, dailyAllowance: config.taco.dailyAllowance });
    }
  }

  const [reactorRow] = await database.select().from(users).where(eq(users.id, input.reactor));
  if (!reactorRow.isActive) return { kind: "ignore", reason: "reactor_inactive" };

  const giver: GiverState = {
    id: reactorRow.id,
    isActive: reactorRow.isActive,
    dailyRemaining: reactorRow.dailyRemaining,
  };

  const v = validate(
    {
      giverId: input.reactor,
      recipientIds,
      tacoCount: 1,
      channelId: input.channelId,
      slackEventId: `react-${input.channelId}-${input.messageTs}-${input.reactor}`,
      channelTs: input.messageTs,
    },
    giver,
    { channels: config.taco.channels, dailyAllowance: config.taco.dailyAllowance },
  );

  if (v.kind === "ignore") return v;
  if (v.kind === "over_allowance") return v;

  const plan = decide({
    giverId: input.reactor,
    recipients: v.recipients,
    perRecipient: v.perRecipient,
    totalDemand: v.totalDemand,
    channelId: input.channelId,
    channelTs: input.messageTs,
    envelopeEventId: `react-${input.channelId}-${input.messageTs}-${input.reactor}`,
    reason: input.messageText?.trim() ? input.messageText : "reaction",
  });

  const result = await executeGive(database, plan);
  if (result.kind === "over_allowance") {
    return { kind: "over_allowance", demand: plan.giverDecrement, remaining: giver.dailyRemaining };
  }
  if (result.kind === "duplicate") {
    return { kind: "ignore", reason: "duplicate" };
  }
  return { kind: "ok", plan, remainingAfter: giver.dailyRemaining - plan.giverDecrement };
}

export function registerReactionHandler(app: App) {
  app.event("reaction_added", async ({ event, client }) => {
    if (!config.taco.acceptedEmojis.includes(event.reaction)) return;
    if (event.item.type !== "message") return;
    if (!config.taco.channels.includes(event.item.channel)) return;

    // Resolve author and message text via conversations.history. Text is
    // captured here (not just the author) so the activity feed can show what
    // the reactor was responding to.
    let author: string | undefined;
    let messageText: string | undefined;
    try {
      const res = await client.conversations.history({
        channel: event.item.channel,
        latest: event.item.ts,
        oldest: event.item.ts,
        inclusive: true,
        limit: 1,
      });
      author = res.messages?.[0]?.user;
      messageText = res.messages?.[0]?.text;
    } catch (err) {
      console.warn("[conversations.history] failed", err);
      return;
    }
    if (!author) return;

    const outcome = await processReaction(db, {
      reactor: event.user,
      author,
      channelId: event.item.channel,
      messageTs: event.item.ts,
      messageText,
    });

    if (outcome.kind === "over_allowance") {
      await client.chat.postEphemeral({
        channel: event.item.channel,
        user: event.user,
        text: overAllowanceMessage(outcome.demand, outcome.remaining),
      });
      return;
    }

    if (outcome.kind !== "ok") return;

    try {
      await client.chat.postMessage({
        channel: event.user,
        text: giveSuccessGiverMessage(outcome.plan, outcome.remainingAfter),
      });
    } catch (err) {
      console.warn("[chat.postMessage giver] failed", err);
    }

    for (const t of outcome.plan.transactions) {
      try {
        await client.chat.postMessage({
          channel: t.toUserId,
          text: giveSuccessRecipientMessage(event.user, t.amount, event.item.channel),
        });
      } catch (err) {
        console.warn("[chat.postMessage recipient] failed", err);
      }
    }
  });

  app.event("reaction_removed", async ({ event, client }) => {
    if (!config.taco.acceptedEmojis.includes(event.reaction)) return;
    if (event.item.type !== "message") return;

    // Echo the actual emoji that was removed in the reversal DMs (the reactor
    // may have given via :taco: or via the alt emoji — the wording should
    // match whichever they actually used).
    const removedEmoji = event.reaction;

    // No allowlist check on reversal: we look up by (channel, ts, reactor),
    // so a non-matching channel naturally yields zero rows. Reversing a give
    // that originated when the channel WAS allowlisted is still desirable.

    const result = await executeReactionReversal(db, {
      channelId: event.item.channel,
      messageTs: event.item.ts,
      reactor: event.user,
      dailyAllowance: config.taco.dailyAllowance,
    });

    if (result.kind !== "ok") return;

    // A single reaction can produce multiple give rows when the message
    // mentioned multiple users; sum per recipient so each one gets a single,
    // tidy DM rather than one per underlying row.
    const perRecipient = new Map<string, number>();
    for (const item of result.reversed) {
      perRecipient.set(item.recipientId, (perRecipient.get(item.recipientId) ?? 0) + item.amount);
    }
    const reactorItems = [...perRecipient].map(([recipientId, amount]) => ({ recipientId, amount }));

    try {
      await client.chat.postMessage({
        channel: event.user,
        text: reactionRemovedReactorMessage(reactorItems, event.item.channel, removedEmoji),
      });
    } catch (err) {
      console.warn("[chat.postMessage reversal reactor] failed", err);
    }

    for (const [rid, amount] of perRecipient) {
      try {
        await client.chat.postMessage({
          channel: rid,
          text: reactionRemovedRecipientMessage(event.user, amount, event.item.channel, removedEmoji),
        });
      } catch (err) {
        console.warn("[chat.postMessage reversal recipient] failed", err);
      }
    }
  });
}
