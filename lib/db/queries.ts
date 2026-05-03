import { asc, eq, sql } from "drizzle-orm";
import { items, users } from "./schema";
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
