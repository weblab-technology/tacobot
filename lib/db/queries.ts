import { and, asc, eq, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { items, transactions, users } from "./schema";
import type { DbLike } from "./types";

/**
 * Insert or update a user. On conflict, updates the name and updatedAt timestamp
 * while preserving all counters (receivedTotal, balance, dailyRemaining).
 */
export async function upsertUser(
  db: DbLike,
  input: { id: string; name: string; dailyAllowance: number },
) {
  await db
    .insert(users)
    .values({
      id: input.id,
      name: input.name,
      dailyRemaining: input.dailyAllowance,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        name: input.name,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Ensure a user row exists for `id`. On insert, name defaults to the id as a
 * placeholder; on conflict, leaves name and counters untouched. Use this from
 * lazy paths (message/reaction handlers) that only have a Slack ID, so a real
 * name resolved later is never clobbered.
 */
export async function ensureUserExists(
  db: DbLike,
  input: { id: string; dailyAllowance: number },
) {
  await db
    .insert(users)
    .values({
      id: input.id,
      name: input.id,
      dailyRemaining: input.dailyAllowance,
    })
    .onConflictDoNothing({ target: users.id });
}

/**
 * List active shop items, cheapest first then alphabetical. Returns only the
 * fields needed for display on `/shop`.
 */
export async function listActiveItems(db: DbLike) {
  return db
    .select({
      id: items.id,
      name: items.name,
      description: items.description,
      imageUrl: items.imageUrl,
      priceTacos: items.priceTacos,
      quantity: items.quantity,
    })
    .from(items)
    .where(eq(items.isActive, true))
    .orderBy(asc(items.priceTacos), asc(items.name));
}

export type GiveGroupKey = {
  fromUserId: string;
  slackChannelId: string;
  slackMessageTs: string;
};

/**
 * For each `(fromUserId, channel, message_ts)` give-group passed in, count
 * how many of its underlying `type='give'` rows have a matching `type='reversal'`
 * row referencing them via `reversed_transaction_id`. Returns a map keyed by
 * `${fromUserId}|${channel}|${messageTs}`. Used by the admin activity page to
 * decide whether to render a "↺ reversed" badge.
 *
 * Counting per-giver matters: a single Slack message can produce multiple
 * give-groups at the same `(channel, ts)` — e.g. the author's text-mention
 * give plus reactor-gives — and those groups can be reversed independently
 * (reactor unreacts but author's message stays).
 */
export async function countReversalsPerGiveGroup(
  db: DbLike,
  groups: GiveGroupKey[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (groups.length === 0) return out;

  const giveTbl = alias(transactions, "g");
  const reversalTbl = alias(transactions, "r");

  const rows = await db
    .select({
      fromUserId: giveTbl.fromUserId,
      slackChannelId: giveTbl.slackChannelId,
      slackMessageTs: giveTbl.slackMessageTs,
      count: sql<number>`count(${reversalTbl.id})::int`,
    })
    .from(giveTbl)
    .leftJoin(
      reversalTbl,
      and(
        eq(reversalTbl.reversedTransactionId, giveTbl.id),
        eq(reversalTbl.type, "reversal"),
      ),
    )
    .where(
      and(
        eq(giveTbl.type, "give"),
        or(
          ...groups.map((g) =>
            and(
              eq(giveTbl.fromUserId, g.fromUserId),
              eq(giveTbl.slackChannelId, g.slackChannelId),
              eq(giveTbl.slackMessageTs, g.slackMessageTs),
            ),
          ),
        ),
      ),
    )
    .groupBy(giveTbl.fromUserId, giveTbl.slackChannelId, giveTbl.slackMessageTs);

  for (const r of rows) {
    out.set(`${r.fromUserId}|${r.slackChannelId}|${r.slackMessageTs}`, r.count);
  }
  return out;
}
