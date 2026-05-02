import type { App } from "@slack/bolt";
import { db } from "@/lib/db/client";
import { upsertUser } from "@/lib/db/queries";
import { config } from "@/lib/config";
import { decide, validate, type GiverState } from "../give";
import { executeGive } from "../execute";
import { getBotUserId } from "../botUserId";
import { overAllowanceMessage } from "../format";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";

export type ReactionInput = {
  reactor: string;
  author: string;
  channelId: string;
  messageTs: string;
};

export type ReactionOutcome =
  | { kind: "ok" }
  | { kind: "ignore"; reason: string }
  | { kind: "over_allowance"; demand: number; remaining: number };

// Permissive db param so this works with both production Vercel Postgres
// and pglite-backed test instances.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function processReaction(database: any, input: ReactionInput): Promise<ReactionOutcome> {
  if (!config.taco.channels.includes(input.channelId)) {
    return { kind: "ignore", reason: "channel_not_allowlisted" };
  }
  const botId = await getBotUserId();
  if (input.author === botId || input.author === input.reactor) {
    return { kind: "ignore", reason: "self_or_bot" };
  }

  await upsertUser(database, { id: input.reactor, name: input.reactor, dailyAllowance: config.taco.dailyAllowance });
  await upsertUser(database, { id: input.author, name: input.author, dailyAllowance: config.taco.dailyAllowance });

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
  return { kind: "ok" };
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
    }
  });
}
