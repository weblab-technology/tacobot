import { afterAll, expect, test, vi } from "vitest";
import { sql, eq } from "drizzle-orm";
import { closePool, withCleanDb } from "./helpers/db";
import { resetDailyAllowance } from "@/app/api/cron/reset-allowance/reset";
import { upsertUser } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";

vi.mock("@/lib/config", () => ({
  config: {
    taco: { channels: ["C_TAQ"], dailyAllowance: 5 },
    slack: { botToken: "xoxb-test", signingSecret: "test" },
    admin: { slackIds: [] },
    shopUrl: "/shop",
    cronSecret: undefined,
  },
}));

test("resetDailyAllowance refills active users", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_B", name: "B", dailyAllowance: 5 });
    await db.execute(sql`UPDATE users SET daily_remaining = 0 WHERE id IN ('U_A', 'U_B')`);

    const count = await resetDailyAllowance(db, 5);
    expect(count).toBe(2);

    const [a] = await db.select().from(users).where(eq(users.id, "U_A"));
    expect(a.dailyRemaining).toBe(5);
  });
});

test("resetDailyAllowance skips inactive users", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_X", name: "X", dailyAllowance: 5 });
    await db.execute(sql`UPDATE users SET is_active = false, daily_remaining = 0 WHERE id = 'U_X'`);
    const count = await resetDailyAllowance(db, 5);
    expect(count).toBe(0);
    const [x] = await db.select().from(users).where(eq(users.id, "U_X"));
    expect(x.dailyRemaining).toBe(0);
  });
});

afterAll(async () => closePool());
