import { eq, sql } from "drizzle-orm";
import { users } from "@/lib/db/schema";

// Permissive db param for cross-driver use (production Vercel Postgres + test pglite).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resetDailyAllowance(db: any, allowance: number): Promise<number> {
  const result = await db
    .update(users)
    .set({ dailyRemaining: allowance, updatedAt: sql`now()` })
    .where(eq(users.isActive, true))
    .returning({ id: users.id });
  return result.length;
}
