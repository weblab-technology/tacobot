import { and, eq, gte, sql } from "drizzle-orm";
import { transactions, users } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";

export type RedeemInput = {
  employeeId: string;
  itemId: string;
  amount: number;
  adminId: string;
  reason: string | null;
};

export type RedeemResult = { kind: "ok" } | { kind: "insufficient" };

export async function redeem(db: DbLike, input: RedeemInput): Promise<RedeemResult> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ balance: sql`${users.balance} - ${input.amount}`, updatedAt: sql`now()` })
      .where(and(eq(users.id, input.employeeId), gte(users.balance, input.amount)))
      .returning({ id: users.id });

    if (updated.length === 0) return { kind: "insufficient" } as const;

    await tx.insert(transactions).values({
      type: "redeem",
      toUserId: input.employeeId,
      adminUserId: input.adminId,
      itemId: input.itemId,
      amount: input.amount,
      reason: input.reason,
    });
    return { kind: "ok" } as const;
  });
}
