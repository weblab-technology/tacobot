import { and, eq, gte, sql } from "drizzle-orm";
import { transactions, users } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";
import type { GivePlan } from "./give";

export type ExecuteResult =
  | { kind: "ok" }
  | { kind: "over_allowance" }
  | { kind: "duplicate" };

class DuplicateGiveError extends Error {
  constructor() {
    super("duplicate");
  }
}

export async function executeGive(db: DbLike, plan: GivePlan): Promise<ExecuteResult> {
  try {
    return (await db.transaction(async (tx) => {
      const decremented = await tx
        .update(users)
        .set({
          dailyRemaining: sql`${users.dailyRemaining} - ${plan.giverDecrement}`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(users.id, plan.giverId), gte(users.dailyRemaining, plan.giverDecrement)))
        .returning({ id: users.id });

      if (decremented.length === 0) {
        // Will rollback when this returns from transaction callback.
        return { kind: "over_allowance" } as const;
      }

      for (const t of plan.transactions) {
        await tx
          .update(users)
          .set({
            receivedTotal: sql`${users.receivedTotal} + ${t.amount}`,
            balance: sql`${users.balance} + ${t.amount}`,
            updatedAt: sql`now()`,
          })
          .where(eq(users.id, t.toUserId));

        const inserted = await tx
          .insert(transactions)
          .values({
            type: "give",
            toUserId: t.toUserId,
            fromUserId: t.fromUserId,
            amount: t.amount,
            reason: t.reason,
            slackEventId: t.slackEventId,
            slackChannelId: t.slackChannelId,
            slackMessageTs: t.slackMessageTs,
          })
          .onConflictDoNothing({ target: transactions.slackEventId })
          .returning({ id: transactions.id });

        if (inserted.length === 0) {
          // Duplicate event_id → Slack retry. Roll back so receiver counters
          // are not double-applied.
          throw new DuplicateGiveError();
        }
      }

      return { kind: "ok" } as const;
    })) as ExecuteResult;
  } catch (err) {
    if (err instanceof DuplicateGiveError) return { kind: "duplicate" } as const;
    throw err;
  }
}
