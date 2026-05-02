import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";

const MIGRATIONS_DIR = join(process.cwd(), "drizzle");

let pglite: PGlite | undefined;
let drizzleDb: ReturnType<typeof drizzle<typeof schema>> | undefined;

async function init() {
  if (pglite && drizzleDb) return drizzleDb;
  pglite = new PGlite();
  drizzleDb = drizzle(pglite, { schema });

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    for (const stmt of text.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await pglite.exec(trimmed);
    }
  }
  return drizzleDb;
}

export type TestDB = NonNullable<typeof drizzleDb>;

export async function getDb(): Promise<TestDB> {
  return init();
}

/**
 * Run `fn` inside a SAVEPOINT that always rolls back. Each test gets a
 * clean slate without truncate overhead. Useful when only one test runs
 * against the DB at a time within a file.
 */
export async function inRollbackTx<T>(fn: (tx: TestDB) => Promise<T>): Promise<T> {
  const db = await init();
  let result!: T;
  let captured: unknown;
  try {
    await db.transaction(async (tx) => {
      result = await fn(tx as unknown as TestDB);
      // Force rollback so test mutations don't persist.
      throw new RollbackSignal();
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) {
      captured = err;
    }
  }
  if (captured) throw captured;
  return result;
}

/**
 * Truncate everything, then run `fn` against the clean DB. Use this when
 * a test needs multiple parallel connections (pglite is single-connection
 * but Promise.all-style tests still work because the in-process DB
 * serializes statements).
 */
export async function withCleanDb<T>(fn: (db: TestDB) => Promise<T>): Promise<T> {
  const db = await init();
  await truncate(db);
  try {
    return await fn(db);
  } finally {
    await truncate(db);
  }
}

async function truncate(db: TestDB) {
  await db.execute(
    sql`TRUNCATE TABLE transactions, items, users RESTART IDENTITY CASCADE`,
  );
}

export async function closePool() {
  if (pglite) {
    await pglite.close();
    pglite = undefined;
    drizzleDb = undefined;
  }
}

class RollbackSignal extends Error {
  constructor() {
    super("rollback");
  }
}
