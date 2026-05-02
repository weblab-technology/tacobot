import { and, eq, gte, sql } from "drizzle-orm";
import { transactions, users } from "@/lib/db/schema";

export type RedeemInput = {
  employeeId: string;
  itemId: string;
  amount: number;
  adminId: string;
  reason: string | null;
};

export type RedeemResult = { kind: "ok" } | { kind: "insufficient" };

// Permissive db param for cross-driver use (production + pglite tests).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function redeem(db: any, input: RedeemInput): Promise<RedeemResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(async (tx: any) => {
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
