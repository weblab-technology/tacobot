import { and, asc, eq, sql } from "drizzle-orm";
import { transactions, users } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";

/**
 * One reversed give. Returned to handlers so they can DM the right people.
 */
export type ReversedItem = {
  giverId: string;
  recipientId: string;
  amount: number;
  originalTransactionId: string;
};

export type ReversalResult =
  | { kind: "ok"; reversed: ReversedItem[] }
  | { kind: "noop" };

type ReversalReason = "message_deleted" | "reaction_removed";

const SLACK_EVENT_PREFIX: Record<ReversalReason, string> = {
  message_deleted: "delete",
  reaction_removed: "unreact",
};

/**
 * Compensate every type='give' transaction tied to a deleted Slack message.
 *
 * For each give:
 *  - Inserts an append-only reversal row referencing the original via
 *    `reversed_transaction_id`. The UNIQUE constraint on that column is the
 *    primary idempotency lever: a Slack retry sees `onConflictDoNothing` and
 *    skips the counter updates entirely.
 *  - Decrements the recipient's `balance` and `received_total` (allowed to go
 *    negative — the user accepted that trade-off when balances are spent).
 *  - Restores the giver's `daily_remaining` capped at `dailyAllowance` so a
 *    cross-midnight reversal can't push past the daily cap (the cron has
 *    already topped them up at 00:00 UTC).
 */
export async function executeMessageReversal(
  db: DbLike,
  input: { channelId: string; messageTs: string; dailyAllowance: number },
): Promise<ReversalResult> {
  return db.transaction(async (tx) => {
    const gives = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.type, "give"),
          eq(transactions.slackChannelId, input.channelId),
          eq(transactions.slackMessageTs, input.messageTs),
        ),
      )
      .orderBy(asc(transactions.createdAt), asc(transactions.id));

    if (gives.length === 0) return { kind: "noop" } as const;

    const reversed = await applyReversals(tx, gives, input.dailyAllowance, "message_deleted");
    if (reversed.length === 0) return { kind: "noop" } as const;
    return { kind: "ok", reversed } as const;
  });
}

/**
 * Compensate the give(s) produced by a single :taco: reaction. A reaction can
 * have produced more than one row when the message it reacted to mentioned
 * multiple users — we look up by `(channel, ts, fromUserId=reactor)` to catch
 * all of them.
 */
export async function executeReactionReversal(
  db: DbLike,
  input: {
    channelId: string;
    messageTs: string;
    reactor: string;
    dailyAllowance: number;
  },
): Promise<ReversalResult> {
  return db.transaction(async (tx) => {
    const gives = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.type, "give"),
          eq(transactions.slackChannelId, input.channelId),
          eq(transactions.slackMessageTs, input.messageTs),
          eq(transactions.fromUserId, input.reactor),
        ),
      )
      .orderBy(asc(transactions.createdAt), asc(transactions.id));

    if (gives.length === 0) return { kind: "noop" } as const;

    const reversed = await applyReversals(tx, gives, input.dailyAllowance, "reaction_removed");
    if (reversed.length === 0) return { kind: "noop" } as const;
    return { kind: "ok", reversed } as const;
  });
}

async function applyReversals(
  tx: DbLike,
  gives: (typeof transactions.$inferSelect)[],
  dailyAllowance: number,
  reason: ReversalReason,
): Promise<ReversedItem[]> {
  const out: ReversedItem[] = [];
  for (const give of gives) {
    // Type='give' rows always have a from_user_id by CHECK constraint, but
    // TypeScript can't see that — assert defensively.
    if (!give.fromUserId) continue;

    const inserted = await tx
      .insert(transactions)
      .values({
        type: "reversal",
        toUserId: give.toUserId,
        amount: give.amount,
        reason,
        slackEventId: `${SLACK_EVENT_PREFIX[reason]}-${give.id}`,
        slackChannelId: give.slackChannelId,
        slackMessageTs: give.slackMessageTs,
        reversedTransactionId: give.id,
      })
      .onConflictDoNothing({ target: transactions.reversedTransactionId })
      .returning({ id: transactions.id });

    // Already reversed (Slack retry, or a partially-applied prior run).
    // Skip counter updates so we don't double-decrement.
    if (inserted.length === 0) continue;

    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} - ${give.amount}`,
        receivedTotal: sql`${users.receivedTotal} - ${give.amount}`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, give.toUserId));

    await tx
      .update(users)
      .set({
        dailyRemaining: sql`LEAST(${users.dailyRemaining} + ${give.amount}, ${dailyAllowance})`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, give.fromUserId));

    out.push({
      giverId: give.fromUserId,
      recipientId: give.toUserId,
      amount: give.amount,
      originalTransactionId: give.id,
    });
  }
  return out;
}
