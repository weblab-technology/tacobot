import { afterAll, expect, test, vi } from "vitest";
import { closePool, withCleanDb } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { sql } from "drizzle-orm";

vi.mock("@/lib/config", () => ({
  config: {
    taco: { channels: ["C_TAQ"], dailyAllowance: 5 },
    slack: { botUserId: "U_BOT", botToken: "xoxb-test", signingSecret: "test" },
    admin: { slackIds: [] },
    shopUrl: "/shop",
    cronSecret: undefined,
  },
}));

// The commands handler imports `db` from @/lib/db/client (production Vercel Postgres).
// We swap it for the pglite test instance so dispatch() queries the same DB
// the test inserts into.
//
// Workaround: vi.mock factory is async so we can await the pglite db directly there.
// We import helpers/db via vi.importActual to get the real helper (not a mock),
// then return its db instance as the mocked @/lib/db/client export.
vi.mock("@/lib/db/client", async () => {
  const helpers = await vi.importActual<typeof import("./helpers/db")>(
    "@/tests/integration/helpers/db",
  );
  return { db: await helpers.getDb() };
});

// Dynamic import after mock registration so the module resolves with the mocked db.
const { __test } = await import("@/lib/slack/handlers/commands");

test("score returns top 5 by received_total, descending", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_A", name: "Alice", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_B", name: "Bob", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_C", name: "Carol", dailyAllowance: 5 });
    await db.execute(sql`UPDATE users SET received_total = 5, balance = 5 WHERE id = 'U_A'`);
    await db.execute(sql`UPDATE users SET received_total = 10, balance = 10 WHERE id = 'U_B'`);
    await db.execute(sql`UPDATE users SET received_total = 3, balance = 3 WHERE id = 'U_C'`);

    const reply = await __test.dispatch("score", "U_X");
    expect(reply).not.toBeNull();
    expect(reply).toContain("Bob — 10");
    expect(reply!.indexOf("Bob")).toBeLessThan(reply!.indexOf("Alice"));
    expect(reply!.indexOf("Alice")).toBeLessThan(reply!.indexOf("Carol"));
  });
});

afterAll(async () => {
  await closePool();
});
