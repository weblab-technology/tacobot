import { and, asc, desc, eq, gte, or, sql } from "drizzle-orm";
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

export type LeaderboardMetric = "received" | "given" | "combined" | "redeemable";

export type LeaderboardRow = {
  userId: string;
  total: number;
};

export type LeaderboardOptions = {
  metric: LeaderboardMetric;
  since: Date | null;
  channel: string | null;
};

/**
 * Active users ranked by net tacos for the chosen metric/period/channel.
 * Net = sum of give amounts minus sum of reversal amounts whose original
 * give matches the same filters (net-by-give-date semantics).
 *
 * `redeemable` is a current-state metric — it reads `users.balance` directly
 * and ignores the period/channel filters, since balance reflects all-time
 * receipts net of reversals and redemptions and isn't channel-scoped.
 */
export async function getLeaderboard(
  db: DbLike,
  opts: LeaderboardOptions,
): Promise<LeaderboardRow[]> {
  if (opts.metric === "redeemable") {
    return runRedeemable(db);
  }
  if (opts.metric !== "combined") {
    return runDirectional(db, opts.metric, opts);
  }
  const [recv, giv] = await Promise.all([
    runDirectional(db, "received", opts),
    runDirectional(db, "given", opts),
  ]);
  const totals = new Map<string, number>();
  for (const r of recv) totals.set(r.userId, (totals.get(r.userId) ?? 0) + r.total);
  for (const r of giv) totals.set(r.userId, (totals.get(r.userId) ?? 0) + r.total);
  return [...totals.entries()]
    .filter(([, total]) => total > 0)
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId));
}

async function runRedeemable(db: DbLike): Promise<LeaderboardRow[]> {
  const rows = await db
    .select({
      userId: users.id,
      total: users.balance,
    })
    .from(users)
    .where(and(eq(users.isActive, true), sql`${users.balance} > 0`))
    .orderBy(desc(users.balance), asc(users.id));
  return rows.map((r) => ({ userId: r.userId, total: r.total }));
}

async function runDirectional(
  db: DbLike,
  direction: "received" | "given",
  opts: { since: Date | null; channel: string | null },
): Promise<LeaderboardRow[]> {
  const g = alias(transactions, direction === "received" ? "g_recv" : "g_giv");
  const r = alias(transactions, direction === "received" ? "r_recv" : "r_giv");
  const u = alias(users, direction === "received" ? "u_recv" : "u_giv");
  const userIdCol = direction === "received" ? g.toUserId : g.fromUserId;

  const whereClauses = [
    eq(g.type, "give"),
    ...(opts.since ? [gte(g.createdAt, opts.since)] : []),
    ...(opts.channel ? [eq(g.slackChannelId, opts.channel)] : []),
  ];

  const totalExpr = sql<number>`(coalesce(sum(${g.amount}), 0) - coalesce(sum(${r.amount}), 0))::int`;

  const rows = await db
    .select({
      userId: sql<string>`${userIdCol}`.as("user_id"),
      total: totalExpr.as("total"),
    })
    .from(g)
    .leftJoin(r, and(eq(r.reversedTransactionId, g.id), eq(r.type, "reversal")))
    .innerJoin(u, and(eq(u.id, userIdCol), eq(u.isActive, true)))
    .where(and(...whereClauses))
    .groupBy(userIdCol)
    .having(sql`(coalesce(sum(${g.amount}), 0) - coalesce(sum(${r.amount}), 0)) > 0`)
    .orderBy(desc(totalExpr), asc(sql`${userIdCol}`));

  return rows.map((row) => ({ userId: row.userId, total: row.total }));
}
