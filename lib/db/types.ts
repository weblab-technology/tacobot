import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Structural type for any Postgres-compatible Drizzle client. Satisfied by:
 * - Production: `@vercel/postgres` Drizzle instance from `lib/db/client.ts`
 * - Tests:      `@electric-sql/pglite` Drizzle instance from `tests/integration/helpers/db.ts`
 *
 * Functions that take a `db` argument should use this so they work in both
 * environments without resorting to `any`.
 */
export type DbLike = PgDatabase<PgQueryResultHKT, typeof schema>;
