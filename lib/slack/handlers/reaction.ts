import type { App } from "@slack/bolt";
import { db } from "@/lib/db/client";
import { ensureUserExists, upsertUser } from "@/lib/db/queries";
import type { DbLike } from "@/lib/db/types";
import { config } from "@/lib/config";
import { decide, validate, type GiverState, type GivePlan } from "../give";
import { executeGive } from "../execute";
import { getBotUserId } from "../botUserId";
import { resolveUserName } from "../userInfo";
import {
  giveSuccessGiverMessage,
  giveSuccessRecipientMessage,
  overAllowanceMessage,
} from "../format";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";

export type ReactionInput = {
  reactor: string;
  author: string;
  channelId: string;
  messageTs: string;
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
  if (input.author === botId || input.author === input.reactor) {
    return { kind: "ignore", reason: "self_or_bot" };
  }

  await ensureUserExists(database, { id: input.reactor, dailyAllowance: config.taco.dailyAllowance });
  await ensureUserExists(database, { id: input.author, dailyAllowance: config.taco.dailyAllowance });
  const [reactorName, authorName] = await Promise.all([
    resolveUserName(input.reactor),
    resolveUserName(input.author),
  ]);
  if (reactorName) {
    await upsertUser(database, { id: input.reactor, name: reactorName, dailyAllowance: config.taco.dailyAllowance });
  }
  if (authorName) {
    await upsertUser(database, { id: input.author, name: authorName, dailyAllowance: config.taco.dailyAllowance });
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
      recipientIds: [input.author],
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
    reason: "reaction",
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
    if (event.reaction !== "taco") return;
    if (event.item.type !== "message") return;
    if (!config.taco.channels.includes(event.item.channel)) return;

    // Resolve author via conversations.history.
    let author: string | undefined;
    try {
      const res = await client.conversations.history({
        channel: event.item.channel,
        latest: event.item.ts,
        oldest: event.item.ts,
        inclusive: true,
        limit: 1,
      });
      author = res.messages?.[0]?.user;
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
}
