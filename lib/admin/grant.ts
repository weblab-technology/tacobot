import { eq, sql } from "drizzle-orm";
import { transactions, users } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";

export type GrantInput = {
  recipientId: string;
  // Signed integer; non-zero. Positive credits, negative claws back.
  amount: number;
  adminId: string;
  reason: string | null;
};

export type GrantResult = { kind: "ok" };

/**
 * Admin-issued balance adjustment. Used for onboarding starter packs and for
 * normalizing balances that drifted during beta. Bypasses the daily-give
 * allowance — `dailyRemaining` is not touched.
 *
 * Both `balance` and `receivedTotal` are moved by the same signed delta so
 * the `balance <= received_total` CHECK is preserved. Both columns may go
 * negative; the schema tolerates that.
 */
export async function grant(db: DbLike, input: GrantInput): Promise<GrantResult> {
  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${input.amount}`,
        receivedTotal: sql`${users.receivedTotal} + ${input.amount}`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, input.recipientId));

    await tx.insert(transactions).values({
      type: "grant",
      toUserId: input.recipientId,
      adminUserId: input.adminId,
      amount: input.amount,
      reason: input.reason,
    });

    return { kind: "ok" as const };
  });
}
