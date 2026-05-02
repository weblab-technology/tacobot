import { sql } from "drizzle-orm";
import { users } from "./schema";

/**
 * Insert or update a user. On conflict, updates the name and updatedAt timestamp
 * while preserving all counters (receivedTotal, balance, dailyRemaining).
 *
 * Works with both production Vercel Postgres and test pglite database instances.
 * Using `any` for the db parameter to accommodate both driver-specific Drizzle types.
 */
export async function upsertUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
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
