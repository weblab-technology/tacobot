# Admin Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/admin/leaderboard` page to the admin panel that ranks users by tacos with three filters: metric (received / given / combined), period (all-time / today / this week / this month), and channel scope.

**Architecture:** Single transactions-derived Drizzle query, computed on-demand per request. A directional helper returns net-of-reversals totals for one direction (received or given); the public function calls it once for received/given, twice for combined and merges totals in JS. Page is a server component mirroring `/admin/activity`.

**Tech Stack:** Next.js 15 App Router · React 19 server components · Tailwind · Drizzle ORM · Vitest + PGlite for integration tests.

**Reference:** `docs/superpowers/specs/2026-05-04-admin-leaderboard-design.md`.

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `lib/date.ts` | modify | Add `periodStart(period, now): Date \| null`. |
| `tests/unit/period-start.test.ts` | create | Unit tests for `periodStart`. |
| `lib/db/queries.ts` | modify | Add `getLeaderboard()` + types `LeaderboardMetric`, `LeaderboardRow`. |
| `tests/integration/leaderboard.test.ts` | create | Integration tests for `getLeaderboard()`. |
| `app/admin/leaderboard/page.tsx` | create | Server component: parses search params, calls query, renders filters + table. |
| `app/admin/layout.tsx` | modify | Add Leaderboard link to nav (between Activity and Users). |
| `app/admin/page.tsx` | modify | Add Leaderboard bullet to admin home. |

The duplicated `displayName` / `Avatar` / channel-mention helpers between activity and the new leaderboard page stay duplicated — three usages don't yet justify a shared module.

---

## Task 1: `periodStart()` helper with unit tests

**Files:**
- Modify: `lib/date.ts`
- Create: `tests/unit/period-start.test.ts`

- [ ] **Step 1.1: Write the failing unit tests**

Create `tests/unit/period-start.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { periodStart } from "@/lib/date";

describe("periodStart", () => {
  test("returns null for 'all'", () => {
    expect(periodStart("all", new Date("2026-05-04T12:00:00Z"))).toBeNull();
  });

  test("returns today 00:00 UTC for 'today'", () => {
    const now = new Date("2026-05-04T12:34:56Z");
    expect(periodStart("today", now)?.toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });

  test("returns same Monday 00:00 UTC when 'now' is on Monday", () => {
    // 2026-05-04 is a Monday
    const monday = new Date("2026-05-04T15:00:00Z");
    expect(periodStart("week", monday)?.toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });

  test("returns previous Monday for 'week' when 'now' is Sunday", () => {
    // 2026-05-10 is a Sunday; previous Monday is 2026-05-04
    const sunday = new Date("2026-05-10T23:59:00Z");
    expect(periodStart("week", sunday)?.toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });

  test("returns previous Monday for 'week' when 'now' is mid-week", () => {
    // 2026-05-07 is a Thursday; current week's Monday is 2026-05-04
    const thursday = new Date("2026-05-07T08:00:00Z");
    expect(periodStart("week", thursday)?.toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });

  test("returns first of month 00:00 UTC for 'month'", () => {
    const now = new Date("2026-05-15T08:00:00Z");
    expect(periodStart("month", now)?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  test("month boundary: midnight UTC on the 1st returns same day", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    expect(periodStart("month", now)?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `pnpm test tests/unit/period-start.test.ts`
Expected: FAIL — `periodStart` is not exported from `@/lib/date`.

- [ ] **Step 1.3: Implement `periodStart()`**

Append to `lib/date.ts` (after `localDayKey`, before `ordinalSuffix`):

```typescript
export type LeaderboardPeriod = "all" | "today" | "week" | "month";

/**
 * Lower-bound Date (inclusive) for a leaderboard period, or null for "all".
 * Boundaries are computed in UTC so they align with the bot's daily reset.
 * Week starts Monday (ISO week).
 */
export function periodStart(period: LeaderboardPeriod, now: Date): Date | null {
  if (period === "all") return null;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === "today") return new Date(Date.UTC(y, m, d));
  if (period === "month") return new Date(Date.UTC(y, m, 1));
  // week — most recent Monday 00:00 UTC. JS getUTCDay: Sun=0..Sat=6.
  // Days to subtract so we land on Monday: Sun→6, Mon→0, Tue→1, ...
  const dow = now.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  return new Date(Date.UTC(y, m, d - daysSinceMonday));
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `pnpm test tests/unit/period-start.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 1.5: Commit**

```bash
git add lib/date.ts tests/unit/period-start.test.ts
git commit -m "feat(date): periodStart helper for leaderboard windows

ISO week (Monday start) + UTC boundaries to match daily-reset semantics."
```

---

## Task 2: `getLeaderboard()` query with integration tests (TDD, incremental)

**Files:**
- Modify: `lib/db/queries.ts`
- Create: `tests/integration/leaderboard.test.ts`

We'll grow the test file and the implementation together. After each test passes, commit.

### Phase 2A — Skeleton + simplest "received" case

- [ ] **Step 2A.1: Write the first failing test**

Create `tests/integration/leaderboard.test.ts`:

```typescript
import { test, expect } from "vitest";
import { inRollbackTx } from "./helpers/db";
import { upsertUser, getLeaderboard } from "@/lib/db/queries";
import { transactions } from "@/lib/db/schema";

async function seedGive(
  tx: Parameters<Parameters<typeof inRollbackTx>[0]>[0],
  opts: {
    fromId: string;
    toId: string;
    amount: number;
    channel?: string;
    ts?: string;
    eventId: string;
    createdAt?: Date;
  },
) {
  const ch = opts.channel ?? "C_TEST";
  const ts = opts.ts ?? `${Date.now()}.0`;
  const [row] = await tx
    .insert(transactions)
    .values({
      type: "give",
      fromUserId: opts.fromId,
      toUserId: opts.toId,
      amount: opts.amount,
      slackEventId: opts.eventId,
      slackChannelId: ch,
      slackMessageTs: ts,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function seedReversal(
  tx: Parameters<Parameters<typeof inRollbackTx>[0]>[0],
  opts: { reversedId: string; toId: string; amount: number; eventId: string; createdAt?: Date },
) {
  await tx.insert(transactions).values({
    type: "reversal",
    toUserId: opts.toId,
    amount: opts.amount,
    reversedTransactionId: opts.reversedId,
    slackEventId: opts.eventId,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
}

test("received: ranks active users by net received tacos, descending", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_B", name: "B", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_C", name: "C", dailyAllowance: 5 });

    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 1, eventId: "e1" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 2, eventId: "e2" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_B", amount: 5, eventId: "e3" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_C", amount: 1, eventId: "e4" });

    const rows = await getLeaderboard(tx, {
      metric: "received",
      since: null,
      channel: null,
    });

    expect(rows).toEqual([
      { userId: "U_B", total: 5 },
      { userId: "U_A", total: 3 },
      { userId: "U_C", total: 1 },
    ]);
  });
});
```

- [ ] **Step 2A.2: Run the test to verify it fails**

Run: `pnpm test tests/integration/leaderboard.test.ts`
Expected: FAIL — `getLeaderboard` is not exported from `@/lib/db/queries`.

- [ ] **Step 2A.3: Implement skeleton + received metric**

Append to `lib/db/queries.ts`:

```typescript
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
// (asc/desc/gte may already need to be added to the existing imports)

export type LeaderboardMetric = "received" | "given" | "combined";

export type LeaderboardRow = {
  userId: string;
  total: number;
};

export type LeaderboardOptions = {
  metric: LeaderboardMetric;
  since: Date | null;
  channel: string | null;
};

/**
 * Active users ranked by net tacos for the chosen metric/period/channel.
 * Net = sum of give amounts minus sum of reversal amounts whose original
 * give matches the same filters (net-by-give-date semantics).
 */
export async function getLeaderboard(
  db: DbLike,
  opts: LeaderboardOptions,
): Promise<LeaderboardRow[]> {
  if (opts.metric !== "combined") {
    return runDirectional(db, opts.metric, opts);
  }
  const [recv, giv] = await Promise.all([
    runDirectional(db, "received", opts),
    runDirectional(db, "given", opts),
  ]);
  const totals = new Map<string, number>();
  for (const r of recv) totals.set(r.userId, (totals.get(r.userId) ?? 0) + r.total);
  for (const r of giv) totals.set(r.userId, (totals.get(r.userId) ?? 0) + r.total);
  return [...totals.entries()]
    .filter(([, total]) => total > 0)
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId));
}

async function runDirectional(
  db: DbLike,
  direction: "received" | "given",
  opts: { since: Date | null; channel: string | null },
): Promise<LeaderboardRow[]> {
  const g = alias(transactions, direction === "received" ? "g_recv" : "g_giv");
  const r = alias(transactions, direction === "received" ? "r_recv" : "r_giv");
  const u = alias(users, direction === "received" ? "u_recv" : "u_giv");
  const userIdCol = direction === "received" ? g.toUserId : g.fromUserId;

  const whereClauses = [
    eq(g.type, "give"),
    ...(opts.since ? [gte(g.createdAt, opts.since)] : []),
    ...(opts.channel ? [eq(g.slackChannelId, opts.channel)] : []),
  ];

  const totalExpr = sql<number>`(coalesce(sum(${g.amount}), 0) - coalesce(sum(${r.amount}), 0))::int`;

  const rows = await db
    .select({
      userId: sql<string>`${userIdCol}`.as("user_id"),
      total: totalExpr.as("total"),
    })
    .from(g)
    .leftJoin(r, and(eq(r.reversedTransactionId, g.id), eq(r.type, "reversal")))
    .innerJoin(u, and(eq(u.id, userIdCol), eq(u.isActive, true)))
    .where(and(...whereClauses))
    .groupBy(userIdCol)
    .having(sql`(coalesce(sum(${g.amount}), 0) - coalesce(sum(${r.amount}), 0)) > 0`)
    .orderBy(desc(totalExpr), asc(sql`${userIdCol}`));

  return rows.map((row) => ({ userId: row.userId, total: row.total }));
}
```

Make sure the imports at the top of `lib/db/queries.ts` include `asc`, `desc`, `gte` (they may need to be added) and that `alias` is imported from `drizzle-orm/pg-core`.

- [ ] **Step 2A.4: Run the test to verify it passes**

Run: `pnpm test tests/integration/leaderboard.test.ts`
Expected: PASS — 1 test green.

- [ ] **Step 2A.5: Commit**

```bash
git add lib/db/queries.ts tests/integration/leaderboard.test.ts
git commit -m "feat(db): getLeaderboard query — received metric"
```

### Phase 2B — Reversal subtraction (net-by-give-date)

- [ ] **Step 2B.1: Add the reversal test**

Append to `tests/integration/leaderboard.test.ts`:

```typescript
test("received: reversal subtracts even when reversal happened outside the period", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    // Original give: 2026-05-04 (inside "this week" if now is also that week)
    const giveId = await seedGive(tx, {
      fromId: "U_GIVER",
      toId: "U_A",
      amount: 3,
      eventId: "e1",
      createdAt: new Date("2026-05-04T10:00:00Z"),
    });
    // Reversal happened a week later (outside any small window starting at the give date)
    await seedReversal(tx, {
      reversedId: giveId,
      toId: "U_A",
      amount: 3,
      eventId: "rev-e1",
      createdAt: new Date("2026-05-15T10:00:00Z"),
    });

    // Window includes the give but not the reversal — reversal still subtracts.
    const rows = await getLeaderboard(tx, {
      metric: "received",
      since: new Date("2026-05-04T00:00:00Z"),
      channel: null,
    });

    expect(rows).toEqual([]); // net is 0, filtered by HAVING
  });
});

test("received: a partially-reversed give nets to the remainder", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    const giveA1 = await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 2, eventId: "g1" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 3, eventId: "g2" });
    await seedReversal(tx, { reversedId: giveA1, toId: "U_A", amount: 2, eventId: "rev-g1" });

    const rows = await getLeaderboard(tx, { metric: "received", since: null, channel: null });
    expect(rows).toEqual([{ userId: "U_A", total: 3 }]);
  });
});
```

- [ ] **Step 2B.2: Run all tests; verify they pass**

Run: `pnpm test tests/integration/leaderboard.test.ts`
Expected: PASS — 3 tests green. (No implementation change should be needed — the reversal LEFT JOIN already handles this. If they fail, debug there.)

- [ ] **Step 2B.3: Commit**

```bash
git add tests/integration/leaderboard.test.ts
git commit -m "test(db): leaderboard nets reversals by give-date"
```

### Phase 2C — Given metric

- [ ] **Step 2C.1: Add the given-metric test**

Append to `tests/integration/leaderboard.test.ts`:

```typescript
test("given: ranks active givers by net amount given, with reversals subtracted", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_X", name: "X", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_Y", name: "Y", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_R1", name: "R1", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R2", name: "R2", dailyAllowance: 5 });

    // X gives 4 total, has 1 reversed → net 3
    const gx1 = await seedGive(tx, { fromId: "U_X", toId: "U_R1", amount: 1, eventId: "x1" });
    await seedGive(tx, { fromId: "U_X", toId: "U_R2", amount: 3, eventId: "x2" });
    await seedReversal(tx, { reversedId: gx1, toId: "U_R1", amount: 1, eventId: "rev-x1" });

    // Y gives 5
    await seedGive(tx, { fromId: "U_Y", toId: "U_R1", amount: 5, eventId: "y1" });

    const rows = await getLeaderboard(tx, { metric: "given", since: null, channel: null });
    expect(rows).toEqual([
      { userId: "U_Y", total: 5 },
      { userId: "U_X", total: 3 },
    ]);
  });
});
```

- [ ] **Step 2C.2: Run; verify pass**

Run: `pnpm test tests/integration/leaderboard.test.ts`
Expected: PASS — 4 tests green. (Implementation already handles this; the directional helper picks `fromUserId`.)

- [ ] **Step 2C.3: Commit**

```bash
git add tests/integration/leaderboard.test.ts
git commit -m "test(db): leaderboard given metric"
```

### Phase 2D — Combined metric

- [ ] **Step 2D.1: Add the combined-metric test**

Append to `tests/integration/leaderboard.test.ts`:

```typescript
test("combined: sums received + given per user; giver-only and receiver-only both rank", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_BOTH", name: "Both", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_GIVER_ONLY", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_RECV_ONLY", name: "Recv", dailyAllowance: 5 });

    // U_BOTH gives 2 to U_RECV_ONLY, receives 4 from U_GIVER_ONLY → combined 6
    await seedGive(tx, { fromId: "U_BOTH", toId: "U_RECV_ONLY", amount: 2, eventId: "b1" });
    await seedGive(tx, { fromId: "U_GIVER_ONLY", toId: "U_BOTH", amount: 4, eventId: "g1" });
    // U_GIVER_ONLY gives 1 more to U_RECV_ONLY → given 5 total
    await seedGive(tx, { fromId: "U_GIVER_ONLY", toId: "U_RECV_ONLY", amount: 1, eventId: "g2" });

    const rows = await getLeaderboard(tx, { metric: "combined", since: null, channel: null });

    // U_BOTH: 4 received + 2 given = 6
    // U_GIVER_ONLY: 0 received + 5 given = 5
    // U_RECV_ONLY: 3 received + 0 given = 3
    expect(rows).toEqual([
      { userId: "U_BOTH", total: 6 },
      { userId: "U_GIVER_ONLY", total: 5 },
      { userId: "U_RECV_ONLY", total: 3 },
    ]);
  });
});
```

- [ ] **Step 2D.2: Run; verify pass**

Run: `pnpm test tests/integration/leaderboard.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 2D.3: Commit**

```bash
git add tests/integration/leaderboard.test.ts
git commit -m "test(db): leaderboard combined metric"
```

### Phase 2E — Period filter

- [ ] **Step 2E.1: Add the period filter test**

Append to `tests/integration/leaderboard.test.ts`:

```typescript
test("period filter: only counts gives whose created_at is >= since", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    await seedGive(tx, {
      fromId: "U_GIVER",
      toId: "U_A",
      amount: 2,
      eventId: "old",
      createdAt: new Date("2026-05-03T23:00:00Z"),
    });
    await seedGive(tx, {
      fromId: "U_GIVER",
      toId: "U_A",
      amount: 5,
      eventId: "today",
      createdAt: new Date("2026-05-04T01:00:00Z"),
    });

    const rows = await getLeaderboard(tx, {
      metric: "received",
      since: new Date("2026-05-04T00:00:00Z"),
      channel: null,
    });
    expect(rows).toEqual([{ userId: "U_A", total: 5 }]);
  });
});
```

- [ ] **Step 2E.2: Run; verify pass**

Run: `pnpm test tests/integration/leaderboard.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 2E.3: Commit**

```bash
git add tests/integration/leaderboard.test.ts
git commit -m "test(db): leaderboard period filter"
```

### Phase 2F — Channel filter, inactive-user exclusion, tiebreak

- [ ] **Step 2F.1: Add the remaining tests**

Append to `tests/integration/leaderboard.test.ts`:

```typescript
test("channel filter: excludes gives in other channels", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 1, channel: "C_X", eventId: "x" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 4, channel: "C_Y", eventId: "y" });

    const rows = await getLeaderboard(tx, {
      metric: "received",
      since: null,
      channel: "C_Y",
    });
    expect(rows).toEqual([{ userId: "U_A", total: 4 }]);
  });
});

test("inactive users are excluded even when they have received tacos", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_GONE", name: "Gone", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_HERE", name: "Here", dailyAllowance: 5 });
    // Deactivate U_GONE
    await tx.execute(sql`UPDATE users SET is_active = false WHERE id = 'U_GONE'`);

    await seedGive(tx, { fromId: "U_GIVER", toId: "U_GONE", amount: 7, eventId: "g1" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_HERE", amount: 2, eventId: "g2" });

    const rows = await getLeaderboard(tx, { metric: "received", since: null, channel: null });
    expect(rows).toEqual([{ userId: "U_HERE", total: 2 }]);
  });
});

test("tie-break: equal totals order by user_id ascending", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_GIVER", name: "Giver", dailyAllowance: 50 });
    await upsertUser(tx, { id: "U_B", name: "B", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });

    await seedGive(tx, { fromId: "U_GIVER", toId: "U_B", amount: 3, eventId: "b" });
    await seedGive(tx, { fromId: "U_GIVER", toId: "U_A", amount: 3, eventId: "a" });

    const rows = await getLeaderboard(tx, { metric: "received", since: null, channel: null });
    expect(rows).toEqual([
      { userId: "U_A", total: 3 },
      { userId: "U_B", total: 3 },
    ]);
  });
});
```

Note: the inactive-user test imports `sql`. Add to the imports at the top of the test file:

```typescript
import { sql } from "drizzle-orm";
```

- [ ] **Step 2F.2: Run; verify pass**

Run: `pnpm test tests/integration/leaderboard.test.ts`
Expected: PASS — 9 tests green.

- [ ] **Step 2F.3: Commit**

```bash
git add tests/integration/leaderboard.test.ts
git commit -m "test(db): leaderboard channel filter, inactive exclusion, tiebreak"
```

---

## Task 3: `/admin/leaderboard` page

**Files:**
- Create: `app/admin/leaderboard/page.tsx`

This page mirrors `/admin/activity` in its filter form + name resolution + channel resolution patterns. The activity page is a useful reference for shape; here we render a much simpler table.

- [ ] **Step 3.1: Create the page directory and file**

Run: `mkdir -p app/admin/leaderboard`

Create `app/admin/leaderboard/page.tsx`:

```typescript
import type { Metadata } from "next";
import Link from "next/link";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getLeaderboard, type LeaderboardMetric } from "@/lib/db/queries";
import { transactions, users } from "@/lib/db/schema";
import { resolveChannelName } from "@/lib/slack/channelInfo";
import { resolveUserName } from "@/lib/slack/userInfo";
import { periodStart, type LeaderboardPeriod } from "@/lib/date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Leaderboard",
};

const SLACK_LINK = (id: string) => `https://slack.com/app_redirect?channel=${id}`;

const METRIC_OPTIONS: { value: LeaderboardMetric; label: string }[] = [
  { value: "received", label: "Tacos received" },
  { value: "given", label: "Tacos given" },
  { value: "combined", label: "Tacos combined" },
];

const PERIOD_OPTIONS: { value: LeaderboardPeriod; label: string }[] = [
  { value: "all", label: "All-time" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

type SearchParams = Promise<{
  metric?: string;
  period?: string;
  channel?: string;
}>;

function parseMetric(v: string | undefined): LeaderboardMetric {
  return v === "given" || v === "combined" ? v : "received";
}

function parsePeriod(v: string | undefined): LeaderboardPeriod {
  return v === "today" || v === "week" || v === "month" ? v : "all";
}

export default async function LeaderboardPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const metric = parseMetric(sp.metric);
  const period = parsePeriod(sp.period);
  const channel = sp.channel?.trim() || null;
  const since = periodStart(period, new Date());

  const [rows, channelIdRows] = await Promise.all([
    getLeaderboard(db, { metric, since, channel }),
    db
      .selectDistinct({ id: transactions.slackChannelId })
      .from(transactions)
      .where(and(eq(transactions.type, "give"), isNotNull(transactions.slackChannelId))),
  ]);

  // Resolve user names for the visible rows.
  const userIds = rows.map((r) => r.userId);
  const userRows = userIds.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const nameById = new Map(userRows.map((u) => [u.id, u.name]));
  const missing = userIds.filter((id) => !nameById.has(id) || nameById.get(id) === id);
  if (missing.length) {
    const resolved = await Promise.all(missing.map((id) => resolveUserName(id)));
    for (let i = 0; i < missing.length; i++) {
      const name = resolved[i];
      if (name) nameById.set(missing[i], name);
    }
  }

  // Resolve channel labels for the dropdown.
  const channelIds = channelIdRows.map((r) => r.id).filter((x): x is string => !!x);
  const labeledChannels = await Promise.all(
    channelIds.map(async (id) => ({ id, name: await resolveChannelName(id) })),
  );
  labeledChannels.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  const ranked = withRanks(rows);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Leaderboard</h1>

      <form method="get" action="/admin/leaderboard" className="flex flex-wrap items-center gap-2 text-sm">
        <label className="sr-only" htmlFor="metric">Metric</label>
        <select
          id="metric"
          name="metric"
          defaultValue={metric}
          className="rounded border border-gray-300 px-2 py-1"
        >
          {METRIC_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="period">Period</label>
        <select
          id="period"
          name="period"
          defaultValue={period}
          className="rounded border border-gray-300 px-2 py-1"
        >
          {PERIOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="channel">Channel</label>
        <select
          id="channel"
          name="channel"
          defaultValue={channel ?? ""}
          className="rounded border border-gray-300 px-2 py-1"
        >
          <option value="">All channels</option>
          {labeledChannels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ? `#${c.name}` : c.id}
            </option>
          ))}
        </select>

        <button type="submit" className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-100">
          Apply
        </button>
        {metric !== "received" || period !== "all" || channel ? (
          <Link href="/admin/leaderboard" className="text-gray-500 hover:text-gray-700 underline">
            clear
          </Link>
        ) : null}
      </form>

      {ranked.length === 0 ? (
        <p className="text-gray-500">No tacos in this view.</p>
      ) : (
        <table className="w-full divide-y divide-gray-200 rounded-lg bg-white">
          <thead className="text-left text-sm text-gray-600">
            <tr>
              <th className="px-4 py-3 w-16">Rank</th>
              <th className="px-4 py-3">Person</th>
              <th className="px-4 py-3 w-40">Total Tacos</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 text-sm">
            {ranked.map((r) => {
              const name = nameById.get(r.userId) ?? r.userId;
              return (
                <tr key={r.userId}>
                  <td className="px-4 py-3 text-gray-500">{r.rank}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar name={name} />
                      <a
                        href={SLACK_LINK(r.userId)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-amber-700 hover:underline"
                      >
                        {name}
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-semibold">🌮 {r.total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function withRanks(rows: { userId: string; total: number }[]) {
  // Sport ranking: ties share rank, next rank skips by group size.
  const out: { userId: string; total: number; rank: number }[] = [];
  let lastTotal: number | null = null;
  let lastRank = 0;
  rows.forEach((row, i) => {
    const rank = lastTotal === row.total ? lastRank : i + 1;
    out.push({ ...row, rank });
    lastTotal = row.total;
    lastRank = rank;
  });
  return out;
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-amber-100 text-xs font-semibold text-amber-800">
      {initials || "?"}
    </div>
  );
}
```

- [ ] **Step 3.2: Type-check the page**

Run: `pnpm typecheck`
Expected: PASS — no type errors.

- [ ] **Step 3.3: Lint**

Run: `pnpm lint`
Expected: PASS — no lint errors.

- [ ] **Step 3.4: Commit**

```bash
git add app/admin/leaderboard/page.tsx
git commit -m "feat(admin): leaderboard page with metric/period/channel filters"
```

---

## Task 4: Wire up navigation

**Files:**
- Modify: `app/admin/layout.tsx`
- Modify: `app/admin/page.tsx`

- [ ] **Step 4.1: Add nav link in admin layout**

Edit `app/admin/layout.tsx`. Find:

```tsx
            <Link href="/admin/activity" className="text-gray-700 hover:text-gray-900">Activity</Link>
            <Link href="/admin/users" className="text-gray-700 hover:text-gray-900">Users</Link>
```

Replace with:

```tsx
            <Link href="/admin/activity" className="text-gray-700 hover:text-gray-900">Activity</Link>
            <Link href="/admin/leaderboard" className="text-gray-700 hover:text-gray-900">Leaderboard</Link>
            <Link href="/admin/users" className="text-gray-700 hover:text-gray-900">Users</Link>
```

- [ ] **Step 4.2: Add bullet on admin home**

Edit `app/admin/page.tsx`. Find:

```tsx
        <li><Link href="/admin/activity" className="text-blue-600 hover:underline">Activity log</Link></li>
        <li><Link href="/admin/users" className="text-blue-600 hover:underline">Users & redemption</Link></li>
```

Replace with:

```tsx
        <li><Link href="/admin/activity" className="text-blue-600 hover:underline">Activity log</Link></li>
        <li><Link href="/admin/leaderboard" className="text-blue-600 hover:underline">Leaderboard</Link></li>
        <li><Link href="/admin/users" className="text-blue-600 hover:underline">Users & redemption</Link></li>
```

- [ ] **Step 4.3: Commit**

```bash
git add app/admin/layout.tsx app/admin/page.tsx
git commit -m "feat(admin): nav link to leaderboard"
```

---

## Task 5: Final verification

- [ ] **Step 5.1: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5.2: Run lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 5.3: Run the full test suite**

Run: `pnpm test`
Expected: PASS — including the 7 new unit tests and 9 new integration tests, with no regressions.

- [ ] **Step 5.4: Manual smoke (only if dev environment is available)**

Start `pnpm dev`, sign in as an admin, navigate to `/admin/leaderboard`. Verify:
- Default view shows all-time received leaderboard with rank/person/total columns.
- Switching to "Tacos given" or "Tacos combined" updates the page.
- Period dropdown narrows to today / this week / this month.
- Channel dropdown narrows to a single channel.
- Empty state appears when filters yield no rows.
- "Clear" link returns to the default view.

Stop the dev server when done.

If you can't run the dev server, say so explicitly — typecheck + lint + tests verify code correctness, not feature correctness in the browser.

---

## Self-review notes (already applied)

- Spec coverage: every spec section maps to a task — `periodStart` (Task 1), query semantics including reversal/active/channel/tiebreak (Task 2 phases A–F), page rendering and filters (Task 3), nav (Task 4), tests (Tasks 1, 2A–2F).
- No placeholders. Every step contains exact code or an exact command.
- Type consistency: `LeaderboardMetric`, `LeaderboardPeriod`, `LeaderboardOptions`, `LeaderboardRow` are introduced once and referenced by exact name in Tasks 2 and 3. `periodStart` signature matches across Tasks 1 and 3.
- Every code-bearing step shows the actual code; every test step shows the assertion.
