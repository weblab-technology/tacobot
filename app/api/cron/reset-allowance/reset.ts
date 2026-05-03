import { eq, sql } from "drizzle-orm";
import { users } from "@/lib/db/schema";
import type { DbLike } from "@/lib/db/types";

export async function resetDailyAllowance(db: DbLike, allowance: number): Promise<number> {
  const result = await db
    .update(users)
    .set({ dailyRemaining: allowance, updatedAt: sql`now()` })
    .where(eq(users.isActive, true))
    .returning({ id: users.id });
  return result.length;
}
