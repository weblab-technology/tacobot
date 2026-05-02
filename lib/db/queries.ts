import { asc, eq, sql } from "drizzle-orm";
import { items, users } from "./schema";

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

/**
 * List all active shop items, ordered by price (ascending) then name (ascending).
 * Returns only the fields needed for display.
 *
 * Works with both production Vercel Postgres and test pglite database instances.
 * Using `any` for the db parameter to accommodate both driver-specific Drizzle types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listActiveItems(database: any) {
  return database
    .select({
      id: items.id,
      name: items.name,
      description: items.description,
      imageUrl: items.imageUrl,
      priceTacos: items.priceTacos,
    })
    .from(items)
    .where(eq(items.isActive, true))
    .orderBy(asc(items.priceTacos), asc(items.name));
}
