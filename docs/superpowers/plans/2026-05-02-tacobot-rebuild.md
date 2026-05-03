# Tacobot Rebuild Implementation Plan

> **EXECUTION STATUS (2026-05-02):** Tasks 1–39 shipped on `feat/tacobot-rebuild`. Tasks 40–46 (Vercel deploy + Slack production wiring + smoke test + HeyTaco cutover) are operator-side and remain. **See [`2026-05-02-tacobot-rebuild-execution.md`](2026-05-02-tacobot-rebuild-execution.md)** for the per-phase execution report, the seven plan deviations that were caught during execution, and the operator handoff checklist for the remaining tasks.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild a 7-year-old Botkit/RTM Slack-bot fork as a Next.js 15 + Bolt + Postgres app on Vercel Pro, including a HeyTaco-style shop catalog and an HR-mediated redemption admin UI for the `wlt-and-shaman` Slack workspace.

**Architecture:** One Next.js App Router project deployed to Vercel. Slack events arrive at `/api/slack/events`, dispatched by a custom Bolt receiver. Postgres (Vercel Postgres / Neon) persisted via Drizzle ORM. Public `/shop` page (RSC). Admin pages at `/admin/*` gated by Auth.js v5 + Slack OIDC + an env-var allowlist. Daily allowance reset via Vercel Cron. Defense-in-depth via DB-level CHECK constraints.

**Tech Stack:** Node 20.x, TypeScript 5 strict, Next.js 15, `@slack/bolt` v4, Drizzle ORM + Drizzle Kit, Auth.js v5, `@vercel/postgres`, Tailwind CSS, Vitest, pnpm.

**Spec reference:** `docs/superpowers/specs/2026-05-02-tacobot-rebuild-design.md`

---

## File Structure

Final layout. Each file has one responsibility; they're created in the order tasks build them up.

```
tacobot/
├── app/
│   ├── api/
│   │   ├── slack/events/route.ts         # POST: Slack events → Bolt
│   │   ├── auth/[...nextauth]/route.ts   # Auth.js handler routes
│   │   └── cron/reset-allowance/route.ts # POST: Vercel Cron daily reset
│   ├── shop/page.tsx                     # Public catalog, server-rendered
│   ├── admin/
│   │   ├── layout.tsx                    # Auth gate + nav
│   │   ├── users/page.tsx                # Users + deduct flow
│   │   ├── users/actions.ts              # Server actions for redemption
│   │   ├── items/page.tsx                # Catalog CRUD
│   │   └── items/actions.ts              # Server actions for items
│   ├── layout.tsx                        # Root layout (Tailwind setup)
│   └── page.tsx                          # Landing → links to /shop
├── lib/
│   ├── slack/
│   │   ├── bolt.ts                       # Bolt app singleton
│   │   ├── receiver.ts                   # Custom App Router receiver
│   │   ├── handlers.ts                   # Registers all Bolt handlers
│   │   ├── give.ts                       # Pure give pipeline (validate/decide)
│   │   ├── execute.ts                    # DB execution of a give plan
│   │   ├── reactions.ts                  # reaction_added handler
│   │   ├── commands.ts                   # Command router + handlers
│   │   ├── userSync.ts                   # team_join + user_change handlers
│   │   ├── parser.ts                     # countTacos, findUserIds
│   │   ├── format.ts                     # Reply text builders
│   │   └── botUserId.ts                  # auth.test cache
│   ├── db/
│   │   ├── schema.ts                     # Drizzle table definitions
│   │   ├── client.ts                     # @vercel/postgres + Drizzle
│   │   └── queries.ts                    # Typed query helpers
│   ├── auth.ts                           # Auth.js config + Slack provider
│   └── config.ts                         # Env-var parsing + typed config
├── scripts/
│   └── sync-users.ts                     # One-shot bulk import
├── drizzle/                              # Generated migrations (committed)
├── tests/
│   ├── unit/
│   │   ├── parser.test.ts
│   │   ├── give-validate.test.ts
│   │   └── give-decide.test.ts
│   ├── integration/
│   │   ├── give-execute.test.ts
│   │   ├── redemption.test.ts
│   │   ├── constraints.test.ts
│   │   └── helpers/db.ts                 # Per-test transaction helper
│   └── setup.ts                          # Vitest global setup
├── .github/workflows/ci.yml
├── .env.example
├── .gitignore
├── .prettierrc
├── drizzle.config.ts
├── eslint.config.mjs
├── next.config.ts
├── package.json
├── pnpm-lock.yaml
├── tailwind.config.ts
├── tsconfig.json
├── vercel.json
└── README.md
```

---

# Phase 1 — Repo Skeleton

## Task 1: Delete legacy JavaScript files

**Files:**
- Delete: `index.js`, `bot.js`, `taco.js`, `db.js`, `slack.js`, `parser.js`, `utils.js`, `slack.test.js`, `taco.test.js`, `package.json`, `package-lock.json`, `yarn.lock`, `README.md`

The 7-year-old fork's source has nothing reusable on a serverless TS stack. Git history preserves it.

- [ ] **Step 1: Delete legacy source files**

```bash
rm index.js bot.js taco.js db.js slack.js parser.js utils.js slack.test.js taco.test.js
```

- [ ] **Step 2: Delete legacy package metadata**

```bash
rm package.json package-lock.json yarn.lock README.md
```

- [ ] **Step 3: Update .gitignore**

```bash
cat > .gitignore <<'EOF'
node_modules/
.pnpm-store/

# Next.js
.next/
out/
next-env.d.ts

# Environment
.env
.env.local
.env*.local

# Drizzle
drizzle/meta/_journal.json

# Vercel
.vercel/

# Testing
coverage/

# Editors
.idea/
.vscode/
.DS_Store

# Legacy (no longer applicable but historically present)
config.js
db.json
EOF
```

- [ ] **Step 4: Verify deletion**

```bash
ls *.js 2>/dev/null && echo "FAIL: js files still exist" || echo "OK"
ls package*.json yarn.lock 2>/dev/null && echo "FAIL: legacy package files exist" || echo "OK"
```

Expected output: `OK` on both lines.

- [ ] **Step 5: Commit**

```bash
git add -A
git -c user.email="$(git log -1 --pretty=format:'%ae')" \
    -c user.name="$(git log -1 --pretty=format:'%an')" \
    commit -m "chore: remove legacy Botkit/RTM implementation

Wipes the 7-year-old JS sources to make room for the TypeScript rewrite.
History preserves them at 9ee0cf5 and earlier."
```

---

## Task 2: Initialize Next.js 15 + TypeScript + Tailwind

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`

We initialize manually rather than `create-next-app` so the layout matches the spec exactly with no leftover scaffolding. pnpm is the package manager.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "tacobot",
  "version": "0.1.0",
  "private": true,
  "engines": {
    "node": ">=20.0.0"
  },
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "dev": "next dev",
    "build": "pnpm db:migrate && next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "sync-users": "tsx scripts/sync-users.ts"
  },
  "dependencies": {
    "@slack/bolt": "^4.0.0",
    "@vercel/postgres": "^0.10.0",
    "drizzle-orm": "^0.36.0",
    "next": "^15.0.0",
    "next-auth": "5.0.0-beta.25",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "autoprefixer": "^10.4.20",
    "drizzle-kit": "^0.28.0",
    "eslint": "^9.0.0",
    "eslint-config-next": "^15.0.0",
    "postcss": "^8.5.0",
    "prettier": "^3.4.0",
    "tailwindcss": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create next.config.ts**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
```

- [ ] **Step 4: Create tailwind.config.ts and postcss.config.mjs**

```ts
// tailwind.config.ts
import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
```

```js
// postcss.config.mjs
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 5: Create app/globals.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color-scheme: light;
}

body {
  @apply bg-white text-gray-900 antialiased;
}
```

- [ ] **Step 6: Create app/layout.tsx**

```tsx
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Tacobot",
  description: "Internal recognition program for wlt-and-shaman",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 7: Create app/page.tsx (placeholder landing)**

```tsx
import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-bold">🌮 Tacobot</h1>
      <p className="mt-4 text-gray-600">
        Internal recognition program. Give tacos in Slack, redeem them via HR.
      </p>
      <div className="mt-8 flex gap-4">
        <Link href="/shop" className="rounded bg-amber-500 px-4 py-2 text-white hover:bg-amber-600">
          Shop
        </Link>
      </div>
    </main>
  );
}
```

- [ ] **Step 8: Install dependencies**

```bash
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm install
```

Expected: lockfile generated, no errors.

- [ ] **Step 9: Verify build & dev**

```bash
pnpm typecheck
```

Expected: PASS (no type errors).

```bash
pnpm dev &
sleep 6
curl -fsSL http://localhost:3000 | grep -q "Tacobot" && echo "OK"
kill %1 2>/dev/null
```

Expected: `OK` (landing page renders).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: initialize Next.js 15 + TypeScript + Tailwind skeleton"
```

---

## Task 3: Add base tooling (Vitest, Drizzle Kit, ESLint, Prettier)

**Files:**
- Create: `vitest.config.ts`, `tests/setup.ts`, `eslint.config.mjs`, `.prettierrc`, `drizzle.config.ts`

- [ ] **Step 1: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    testTimeout: 10000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
```

- [ ] **Step 2: Create tests/setup.ts**

```ts
// Global setup — currently a no-op placeholder; integration tests
// will register their own per-suite hooks.
export {};
```

- [ ] **Step 3: Create eslint.config.mjs**

```js
import nextPlugin from "eslint-config-next";

export default [
  ...nextPlugin,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
```

- [ ] **Step 4: Create .prettierrc**

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 5: Create drizzle.config.ts**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.POSTGRES_URL ?? "",
  },
  strict: true,
});
```

- [ ] **Step 6: Verify tooling**

```bash
pnpm vitest run --reporter=verbose
```

Expected: "No test files found" (passes; no tests yet but Vitest is wired).

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: add Vitest, ESLint, Prettier, Drizzle Kit configs"
```

---

# Phase 2 — Database Schema

## Task 4: Drizzle client setup

**Files:**
- Create: `lib/db/client.ts`

The client is a Drizzle handle around `@vercel/postgres`. In production, `POSTGRES_URL` is auto-injected by Vercel. In tests we point at a separate DB.

- [ ] **Step 1: Create lib/db/client.ts**

```ts
import { sql } from "@vercel/postgres";
import { drizzle } from "drizzle-orm/vercel-postgres";
import * as schema from "./schema";

export const db = drizzle(sql, { schema });
export type DB = typeof db;
```

- [ ] **Step 2: Create empty schema barrel (so the import resolves)**

```bash
mkdir -p lib/db
cat > lib/db/schema.ts <<'EOF'
// Tables added by subsequent tasks.
export {};
EOF
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(db): add Drizzle client wired to @vercel/postgres"
```

---

## Task 5: `users` table schema

**Files:**
- Modify: `lib/db/schema.ts`

- [ ] **Step 1: Replace lib/db/schema.ts with users table**

```ts
import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),                                  // Slack user ID, "U..."
    name: text("name").notNull(),
    dailyRemaining: integer("daily_remaining").notNull(),
    receivedTotal: integer("received_total").notNull().default(0),
    balance: integer("balance").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dailyNonNegative: check("users_daily_remaining_nonneg", sql`${t.dailyRemaining} >= 0`),
    receivedNonNegative: check("users_received_total_nonneg", sql`${t.receivedTotal} >= 0`),
    balanceNonNegative: check("users_balance_nonneg", sql`${t.balance} >= 0`),
    balanceLeReceived: check(
      "users_balance_le_received",
      sql`${t.balance} <= ${t.receivedTotal}`,
    ),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(db): add users schema with non-negative CHECK constraints"
```

---

## Task 6: `items` table schema

**Files:**
- Modify: `lib/db/schema.ts`

- [ ] **Step 1: Append items table to lib/db/schema.ts**

```ts
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ... users table above ...

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    priceTacos: integer("price_tacos").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pricePositive: check("items_price_positive", sql`${t.priceTacos} > 0`),
    activeNameUnique: uniqueIndex("items_active_name_unique")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.isActive}`),
  }),
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/db/schema.ts
git commit -m "feat(db): add items schema with positive-price CHECK + active-name unique index"
```

---

## Task 7: `transactions` table schema with shape-and-rule CHECK

**Files:**
- Modify: `lib/db/schema.ts`

- [ ] **Step 1: Append transactions table to lib/db/schema.ts**

```ts
// At top, extend imports:
import { index } from "drizzle-orm/pg-core";

// ... users and items above ...

export const transactionType = ["give", "redeem"] as const;
export type TransactionType = (typeof transactionType)[number];

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type", { enum: transactionType }).notNull(),
    toUserId: text("to_user_id").notNull().references(() => users.id),
    fromUserId: text("from_user_id").references(() => users.id),
    adminUserId: text("admin_user_id").references(() => users.id),
    itemId: uuid("item_id").references(() => items.id),
    amount: integer("amount").notNull(),
    reason: text("reason"),
    slackEventId: text("slack_event_id").unique(),
    slackChannelId: text("slack_channel_id"),
    slackMessageTs: text("slack_message_ts"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    amountPositive: check("transactions_amount_positive", sql`${t.amount} > 0`),
    shapeAndRule: check(
      "transactions_shape_and_rule",
      sql`(
        (${t.type} = 'give'
          AND ${t.fromUserId} IS NOT NULL
          AND ${t.adminUserId} IS NULL
          AND ${t.itemId} IS NULL
          AND ${t.fromUserId} <> ${t.toUserId})
        OR
        (${t.type} = 'redeem'
          AND ${t.fromUserId} IS NULL
          AND ${t.adminUserId} IS NOT NULL
          AND ${t.itemId} IS NOT NULL)
      )`,
    ),
    toCreatedIdx: index("transactions_to_created").on(t.toUserId, t.createdAt),
    fromCreatedIdx: index("transactions_from_created").on(t.fromUserId, t.createdAt),
    typeCreatedIdx: index("transactions_type_created").on(t.type, t.createdAt),
    adminCreatedIdx: index("transactions_admin_created").on(t.adminUserId, t.createdAt),
  }),
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/db/schema.ts
git commit -m "feat(db): add transactions ledger with shape-and-rule CHECK constraint"
```

---

## Task 8: Generate first migration & verify against a real Postgres

**Files:**
- Create: `drizzle/0000_*.sql` (auto-generated)
- Create: `tests/integration/helpers/db.ts`

We need a real Postgres for both migration verification and integration tests. Use a local Docker container for now; CI uses a service container later.

- [ ] **Step 1: Spin up a local Postgres**

```bash
docker run -d --name tacobot-pg \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tacobot \
  -p 55432:5432 postgres:16
sleep 3
```

- [ ] **Step 2: Generate the migration**

```bash
echo 'POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot' > .env.local
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm db:generate
ls drizzle/*.sql
```

Expected: A new `drizzle/0000_*.sql` file exists.

- [ ] **Step 3: Inspect the migration**

```bash
cat drizzle/0000_*.sql
```

Verify visually: `CREATE TABLE users`, `CREATE TABLE items`, `CREATE TABLE transactions`, all CHECK constraints present, indices present.

- [ ] **Step 4: Apply migration**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm db:migrate
```

Expected: "applied X migrations" / no errors.

- [ ] **Step 5: Verify schema in Postgres**

```bash
docker exec tacobot-pg psql -U postgres -d tacobot -c "\d users"
docker exec tacobot-pg psql -U postgres -d tacobot -c "\d items"
docker exec tacobot-pg psql -U postgres -d tacobot -c "\d transactions"
docker exec tacobot-pg psql -U postgres -d tacobot -c "SELECT conname FROM pg_constraint WHERE contype='c';"
```

Expected: all three tables present, four CHECK constraints listed (`users_*`, `items_price_positive`, `transactions_amount_positive`, `transactions_shape_and_rule`).

- [ ] **Step 6: Create tests/integration/helpers/db.ts**

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/lib/db/schema";

const TEST_URL = process.env.POSTGRES_URL_TEST ?? process.env.POSTGRES_URL;
if (!TEST_URL) throw new Error("Set POSTGRES_URL_TEST or POSTGRES_URL for tests");

const pool = new Pool({ connectionString: TEST_URL, max: 4 });

export const testDb = drizzle(pool, { schema });
export type TestDB = typeof testDb;

/**
 * Run `fn` inside a SAVEPOINT-wrapped transaction that always rolls back.
 * Each test gets a clean slate without truncate/cleanup overhead.
 */
export async function inRollbackTx<T>(fn: (tx: TestDB) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = drizzle(client, { schema });
    try {
      const result = await fn(tx as unknown as TestDB);
      return result;
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
```

Add `pg` to dev deps:

```bash
pnpm add -D pg @types/pg
```

- [ ] **Step 7: Sanity test (no logic, just connectivity)**

Create `tests/integration/db-smoke.test.ts`:

```ts
import { afterAll, expect, test } from "vitest";
import { closePool, inRollbackTx } from "./helpers/db";
import { users } from "@/lib/db/schema";

test("inRollbackTx isolates writes", async () => {
  await inRollbackTx(async (tx) => {
    await tx.insert(users).values({
      id: "U_TEST",
      name: "Test",
      dailyRemaining: 5,
    });
    const rows = await tx.select().from(users);
    expect(rows).toHaveLength(1);
  });
  // After rollback, no rows persisted — but we can't easily query outside the
  // transaction here since this test owns the only client. Trust the BEGIN/ROLLBACK.
});

afterAll(async () => {
  await closePool();
});
```

- [ ] **Step 8: Run the smoke test**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test
```

Expected: 1 test passes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(db): generate initial migration and add integration test harness"
```

---

# Phase 3 — Config & Environment

## Task 9: Type-safe env config

**Files:**
- Create: `lib/config.ts`, `.env.example`

We parse env vars once at module-load and export a typed config object. Crashes fast if a required var is missing.

- [ ] **Step 1: Create lib/config.ts**

```ts
function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

function csv(name: string): string[] {
  const v = optional(name);
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function intWithDefault(name: string, fallback: number): number {
  const v = optional(name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid integer for ${name}: ${v}`);
  }
  return n;
}

export const config = {
  slack: {
    botToken: required("SLACK_BOT_TOKEN"),
    signingSecret: required("SLACK_SIGNING_SECRET"),
    botUserId: optional("SLACK_BOT_USER_ID"),
    clientId: optional("SLACK_CLIENT_ID"),         // required for admin OIDC
    clientSecret: optional("SLACK_CLIENT_SECRET"), // required for admin OIDC
  },
  taco: {
    channels: csv("TACO_CHANNELS"),
    dailyAllowance: intWithDefault("TACO_DAILY_ALLOWANCE", 5),
  },
  admin: {
    slackIds: csv("ADMIN_SLACK_IDS"),
  },
  shopUrl: optional("NEXT_PUBLIC_SHOP_URL") ?? "/shop",
  cronSecret: optional("CRON_SECRET"),
} as const;

export type AppConfig = typeof config;
```

- [ ] **Step 2: Create .env.example**

```bash
# Slack — bot side
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_BOT_USER_ID=U...                     # optional; learned from auth.test if absent
TACO_CHANNELS=C0123ABCDE                   # comma-separated channel IDs
TACO_DAILY_ALLOWANCE=5

# Slack — Sign in with Slack (admin pages)
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
ADMIN_SLACK_IDS=U0123ABC,U0456DEF          # comma-separated

# Auth.js
AUTH_SECRET=                               # openssl rand -base64 32
AUTH_URL=http://localhost:3000             # auto on Vercel via VERCEL_URL

# Database
POSTGRES_URL=postgres://...

# Public
NEXT_PUBLIC_SHOP_URL=http://localhost:3000/shop

# Cron
CRON_SECRET=                               # auto-managed on Vercel
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(config): add type-safe env-var parsing"
```

---

# Phase 4 — Slack App Configuration

## Task 10: Create the Slack app & document scopes (manual checklist)

**Files:**
- Modify: `README.md` (added in Task 50; for now, create `docs/slack-setup.md` as scratch)

This is a manual operator step. The implementation plan can't perform it — but it must be done before the bot can receive events. Capture the steps in a doc so they're reproducible.

- [ ] **Step 1: Create docs/slack-setup.md** (this gets folded into README.md in Task 50)

```markdown
# Slack App Setup (one-time, manual)

1. **Create the app:** https://api.slack.com/apps?new_app=1 → "From scratch".
   App name: `Tacobot`. Workspace: `wlt-and-shaman`.

2. **Bot scopes** (OAuth & Permissions → Bot Token Scopes):
   - `chat:write`
   - `reactions:write`
   - `reactions:read`
   - `users:read`
   - `channels:history`
   - `groups:history`
   - `im:history`
   - `app_mentions:read`
   - `team:read`

3. **Event subscriptions** (Event Subscriptions → enable):
   - Request URL: `https://<deploy-host>/api/slack/events`
     (use Vercel preview URL during setup; flip to production URL on launch)
   - Subscribe to bot events:
     - `message.channels`
     - `message.im`
     - `app_mention`
     - `reaction_added`
     - `team_join`
     - `user_change`

4. **Sign in with Slack** (OAuth & Permissions → Redirect URLs):
   - Add: `https://<deploy-host>/api/auth/callback/slack`
   - In OpenID Connect (User Token Scopes section): add `openid`, `profile`, `email`.

5. **Install app to workspace.** Copy:
   - **Bot User OAuth Token** (`xoxb-...`) → `SLACK_BOT_TOKEN`
   - **Signing Secret** (Basic Information) → `SLACK_SIGNING_SECRET`
   - **Client ID** / **Client Secret** (Basic Information) → `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`
   - **Bot User ID** (Apps → your app → App Home → bot details) → `SLACK_BOT_USER_ID`

6. **Channel IDs:** find your taqueria channel(s) — right-click → "View channel details"
   → ID at bottom. Set `TACO_CHANNELS=C0123ABCDE`.

7. **Invite the bot:** in `#taqueria-beta`, run `/invite @tacobot`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/slack-setup.md
git commit -m "docs: add Slack app setup checklist"
```

**Note for execution:** the operator must complete this before Phase 5's smoke test will work end-to-end. The code in Phase 5 doesn't require the Slack app to exist — only the manual end-to-end check at the end does.

---

# Phase 5 — Bolt Receiver

## Task 11: Research current Bolt + App Router pattern via context7

**Files:**
- Create: `docs/bolt-app-router-notes.md` (scratch; consolidated into README later)

Bolt v4 + Next.js App Router has churned; we verify the current idiomatic shape before writing code.

- [ ] **Step 1: Use context7 to fetch @slack/bolt documentation**

Run (within the Claude session):

```
Use ToolSearch to load mcp__plugin_context7_context7__resolve-library-id and query-docs.
Resolve "@slack/bolt" → library id.
Query docs: "custom receiver Next.js App Router signing secret verification"
```

- [ ] **Step 2: Use context7 to fetch Next.js docs for raw request body handling**

Resolve `next` library id. Query: "Route Handler raw request body Buffer for signature verification".

Capture findings: which Bolt class/method is current (`Receiver`, `App.processEvent`, `App.processBeforeResponse`), and how App Router exposes the raw body (`request.text()`).

- [ ] **Step 3: Write docs/bolt-app-router-notes.md with the findings**

```markdown
# Bolt + Next.js App Router — verified pattern

(Filled in after context7 lookup. Capture: receiver class to use, method names,
ack semantics, raw-body handling.)
```

- [ ] **Step 4: Commit**

```bash
git add docs/bolt-app-router-notes.md
git commit -m "docs: capture verified Bolt + App Router integration pattern"
```

---

## Task 12: Implement custom Bolt receiver with signature verification

**Files:**
- Create: `lib/slack/receiver.ts`, `lib/slack/bolt.ts`

The receiver is a thin adapter: takes a Next.js `Request`, hands the verified body to Bolt's processing pipeline, returns the ACK response.

Bolt's `App` class exposes `processEvent({ body, ack })` (or, depending on version, an internal method). We build a Receiver that satisfies Bolt's interface (`init`, `start`, `stop`, `processEvent`) and exposes a single async method we can call from the route.

- [ ] **Step 1: Create lib/slack/receiver.ts**

Apply the pattern verified in Task 11. The structural shape is:

```ts
import type { App, Receiver, ReceiverEvent } from "@slack/bolt";
import crypto from "node:crypto";

export class AppRouterReceiver implements Receiver {
  private app?: App;
  constructor(private signingSecret: string) {}

  init(app: App) { this.app = app; }
  async start() { /* no-op for HTTP-style receiver */ }
  async stop() { /* no-op */ }

  async handle(req: Request): Promise<Response> {
    if (!this.app) throw new Error("Receiver not initialized");

    const rawBody = await req.text();
    const ts = req.headers.get("x-slack-request-timestamp") ?? "";
    const sig = req.headers.get("x-slack-signature") ?? "";
    if (!this.verify(ts, sig, rawBody)) {
      return new Response("invalid signature", { status: 401 });
    }

    const parsed = JSON.parse(rawBody);

    // URL verification handshake
    if (parsed.type === "url_verification") {
      return Response.json({ challenge: parsed.challenge });
    }

    let ackPayload: unknown = "";
    let acked = false;
    const event: ReceiverEvent = {
      body: parsed,
      ack: async (response) => {
        acked = true;
        ackPayload = response ?? "";
      },
    };

    await this.app.processEvent(event);

    // If a handler forgot to ack, default 200.
    if (!acked) ackPayload = "";

    return new Response(typeof ackPayload === "string" ? ackPayload : JSON.stringify(ackPayload), {
      status: 200,
      headers: typeof ackPayload === "string" ? {} : { "content-type": "application/json" },
    });
  }

  private verify(ts: string, sig: string, body: string): boolean {
    if (!ts || !sig) return false;
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return false;
    if (Math.abs(Date.now() / 1000 - tsNum) > 60 * 5) return false; // 5-min replay window

    const base = `v0:${ts}:${body}`;
    const hmac = crypto.createHmac("sha256", this.signingSecret).update(base).digest("hex");
    const expected = `v0=${hmac}`;
    if (sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }
}
```

(If Task 11's research showed Bolt v4 exposes a different method than `processEvent`, substitute that name.)

- [ ] **Step 2: Create lib/slack/bolt.ts**

```ts
import { App } from "@slack/bolt";
import { config } from "@/lib/config";
import { AppRouterReceiver } from "./receiver";

export const receiver = new AppRouterReceiver(config.slack.signingSecret);

export const boltApp = new App({
  token: config.slack.botToken,
  receiver,
  // Handlers added by lib/slack/handlers.ts (registered later).
});
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(slack): add custom App Router receiver with signature verification"
```

---

## Task 13: Wire `/api/slack/events` route + URL-verification smoke test

**Files:**
- Create: `app/api/slack/events/route.ts`
- Create: `tests/integration/slack-events.test.ts`

- [ ] **Step 1: Create app/api/slack/events/route.ts**

```ts
import { receiver } from "@/lib/slack/bolt";
// Side-effect import will register handlers (added in later phases):
import "@/lib/slack/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return receiver.handle(req);
}
```

- [ ] **Step 2: Create empty handlers barrel so the import resolves**

```ts
// lib/slack/handlers.ts
import { boltApp } from "./bolt";

// Handlers registered by subsequent phases.
void boltApp;
```

- [ ] **Step 3: Write a unit test for signature verification**

`tests/unit/receiver-verify.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import crypto from "node:crypto";
import { AppRouterReceiver } from "@/lib/slack/receiver";

const SECRET = "test-secret";

function sign(body: string, ts: string): string {
  const base = `v0:${ts}:${body}`;
  return `v0=${crypto.createHmac("sha256", SECRET).update(base).digest("hex")}`;
}

describe("AppRouterReceiver signature verification", () => {
  test("rejects requests with no timestamp", async () => {
    const r = new AppRouterReceiver(SECRET);
    const res = await r.handle(
      new Request("http://localhost/api/slack/events", {
        method: "POST",
        body: "{}",
        headers: { "x-slack-signature": "x" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("rejects requests with stale timestamp", async () => {
    const r = new AppRouterReceiver(SECRET);
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 10);
    const body = "{}";
    const res = await r.handle(
      new Request("http://localhost/api/slack/events", {
        method: "POST",
        body,
        headers: {
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sign(body, ts),
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("rejects invalid signature", async () => {
    const r = new AppRouterReceiver(SECRET);
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await r.handle(
      new Request("http://localhost/api/slack/events", {
        method: "POST",
        body: "{}",
        headers: {
          "x-slack-request-timestamp": ts,
          "x-slack-signature": "v0=deadbeef",
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("accepts valid url_verification handshake", async () => {
    const r = new AppRouterReceiver(SECRET);
    // App must be initialized for handle() to read this.app — but
    // url_verification short-circuits before processEvent. We init with a stub.
    r.init({ processEvent: async () => {} } as never);
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await r.handle(
      new Request("http://localhost/api/slack/events", {
        method: "POST",
        body,
        headers: {
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sign(body, ts),
        },
      }),
    );
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.challenge).toBe("abc123");
  });
});
```

- [ ] **Step 4: Run the test**

```bash
pnpm test tests/unit/receiver-verify.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(slack): wire /api/slack/events route with URL-verification + signature tests"
```

---

# Phase 6 — Parser & Pure Give Logic

## Task 14: `countTacos` parser function (TDD)

**Files:**
- Create: `lib/slack/parser.ts`, `tests/unit/parser-countTacos.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/parser-countTacos.test.ts
import { describe, expect, test } from "vitest";
import { countTacos } from "@/lib/slack/parser";

describe("countTacos", () => {
  test("returns 0 for text with no taco emoji", () => {
    expect(countTacos("Thanks!")).toBe(0);
  });

  test("counts a single :taco:", () => {
    expect(countTacos("Thanks :taco:")).toBe(1);
  });

  test("counts multiple :taco: in a row", () => {
    expect(countTacos(":taco: :taco: :taco:")).toBe(3);
  });

  test("counts non-adjacent :taco: anywhere in the message", () => {
    expect(countTacos("nice :taco: work team :taco:")).toBe(2);
  });

  test("ignores other emoji", () => {
    expect(countTacos(":heart: :pizza: :taco: :coffee:")).toBe(1);
  });

  test("does not match :tacos: or :taco_truck:", () => {
    expect(countTacos(":tacos: :taco_truck:")).toBe(0);
  });

  test("handles empty string", () => {
    expect(countTacos("")).toBe(0);
  });
});
```

- [ ] **Step 2: Run; expect failures**

```bash
pnpm test tests/unit/parser-countTacos.test.ts
```

Expected: FAIL — `countTacos` not exported.

- [ ] **Step 3: Implement countTacos in lib/slack/parser.ts**

```ts
const TACO_RE = /:taco:/g;

export function countTacos(text: string): number {
  if (!text) return 0;
  // Use exact `:taco:` token; no false positives from `:tacos:` because
  // we anchor on the closing colon.
  return text.match(TACO_RE)?.length ?? 0;
}
```

- [ ] **Step 4: Re-run tests**

```bash
pnpm test tests/unit/parser-countTacos.test.ts
```

Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(parser): countTacos with no false-positive on :tacos: / :taco_truck:"
```

---

## Task 15: `findUserIds` parser function (TDD)

**Files:**
- Modify: `lib/slack/parser.ts`
- Create: `tests/unit/parser-findUserIds.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/parser-findUserIds.test.ts
import { describe, expect, test } from "vitest";
import { findUserIds } from "@/lib/slack/parser";

describe("findUserIds", () => {
  test("returns empty array for no mentions", () => {
    expect(findUserIds("hello world")).toEqual([]);
  });

  test("extracts a single <@U…> mention", () => {
    expect(findUserIds("<@U0123ABC>")).toEqual(["U0123ABC"]);
  });

  test("extracts multiple distinct mentions", () => {
    expect(findUserIds("<@U0123ABC> and <@U0456DEF>")).toEqual([
      "U0123ABC",
      "U0456DEF",
    ]);
  });

  test("handles <@U…|displayname> form", () => {
    expect(findUserIds("<@U0123ABC|alex>")).toEqual(["U0123ABC"]);
  });

  test("deduplicates repeat mentions", () => {
    expect(findUserIds("<@U0123ABC> hi <@U0123ABC|alex>")).toEqual(["U0123ABC"]);
  });

  test("ignores team mentions like <!channel> or <!here>", () => {
    expect(findUserIds("<!channel> <@U0123ABC> <!here>")).toEqual(["U0123ABC"]);
  });

  test("supports W-prefixed enterprise grid IDs", () => {
    expect(findUserIds("<@W0123ABC>")).toEqual(["W0123ABC"]);
  });
});
```

- [ ] **Step 2: Run; expect failures**

```bash
pnpm test tests/unit/parser-findUserIds.test.ts
```

Expected: FAIL — `findUserIds` not exported.

- [ ] **Step 3: Add findUserIds to lib/slack/parser.ts**

```ts
const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g;

export function findUserIds(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    seen.add(m[1]);
  }
  return [...seen];
}
```

- [ ] **Step 4: Re-run**

```bash
pnpm test tests/unit/parser-findUserIds.test.ts
```

Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(parser): findUserIds handles <@U|name> form, dedups, ignores team refs"
```

---

## Task 16: Give pipeline — `validate` phase (TDD)

**Files:**
- Create: `lib/slack/give.ts`, `tests/unit/give-validate.test.ts`

The validate phase is pure: takes a parsed give intent + giver state + config, returns either a typed error or a Plan to execute.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/give-validate.test.ts
import { describe, expect, test } from "vitest";
import { validate, type Intent, type GiverState } from "@/lib/slack/give";

const config = {
  channels: ["C_TAQ"],
  dailyAllowance: 5,
};

const giver: GiverState = {
  id: "U_GIVER",
  isActive: true,
  dailyRemaining: 5,
};

const baseIntent: Intent = {
  giverId: "U_GIVER",
  recipientIds: ["U_BOB"],
  tacoCount: 1,
  channelId: "C_TAQ",
  slackEventId: "Ev1",
  channelTs: "1700000000.0",
};

describe("validate", () => {
  test("accepts a typical single-recipient give", () => {
    const r = validate(baseIntent, giver, config);
    expect(r.kind).toBe("ok");
  });

  test("rejects when channel is not in allowlist", () => {
    const r = validate({ ...baseIntent, channelId: "C_OTHER" }, giver, config);
    expect(r.kind).toBe("ignore");
    if (r.kind === "ignore") expect(r.reason).toBe("channel_not_allowlisted");
  });

  test("ignores when zero tacos", () => {
    const r = validate({ ...baseIntent, tacoCount: 0 }, giver, config);
    expect(r.kind).toBe("ignore");
  });

  test("ignores when no recipients", () => {
    const r = validate({ ...baseIntent, recipientIds: [] }, giver, config);
    expect(r.kind).toBe("ignore");
  });

  test("rejects giver who is inactive", () => {
    const r = validate(baseIntent, { ...giver, isActive: false }, config);
    expect(r.kind).toBe("ignore");
    if (r.kind === "ignore") expect(r.reason).toBe("giver_inactive");
  });

  test("rejects when total demand exceeds allowance", () => {
    const r = validate({ ...baseIntent, tacoCount: 6 }, giver, config);
    expect(r.kind).toBe("over_allowance");
    if (r.kind === "over_allowance") {
      expect(r.demand).toBe(6);
      expect(r.remaining).toBe(5);
    }
  });

  test("strips self-mention from recipients", () => {
    const r = validate(
      { ...baseIntent, recipientIds: ["U_GIVER", "U_BOB"] },
      giver,
      config,
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.recipients).toEqual(["U_BOB"]);
  });

  test("ignores if all recipients filtered out (only self)", () => {
    const r = validate({ ...baseIntent, recipientIds: ["U_GIVER"] }, giver, config);
    expect(r.kind).toBe("ignore");
  });

  test("computes total demand as count × recipients", () => {
    const r = validate(
      { ...baseIntent, recipientIds: ["U_BOB", "U_CAROL"], tacoCount: 2 },
      { ...giver, dailyRemaining: 5 },
      config,
    );
    // 2 × 2 = 4, fits in 5 → ok
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.totalDemand).toBe(4);
  });

  test("sorts recipients ascending for stable event ID", () => {
    const r = validate(
      { ...baseIntent, recipientIds: ["U_C", "U_A", "U_B"] },
      giver,
      config,
    );
    if (r.kind === "ok") expect(r.recipients).toEqual(["U_A", "U_B", "U_C"]);
  });
});
```

- [ ] **Step 2: Run; expect failures**

```bash
pnpm test tests/unit/give-validate.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create lib/slack/give.ts with the validate function**

```ts
export type Intent = {
  giverId: string;
  recipientIds: string[];
  tacoCount: number;
  channelId: string;
  slackEventId: string;
  channelTs: string;
};

export type GiverState = {
  id: string;
  isActive: boolean;
  dailyRemaining: number;
};

export type ValidateConfig = {
  channels: string[];
  dailyAllowance: number;
};

export type ValidateResult =
  | {
      kind: "ok";
      recipients: string[];
      totalDemand: number;
      perRecipient: number;
    }
  | { kind: "ignore"; reason: string }
  | { kind: "over_allowance"; demand: number; remaining: number };

export function validate(
  intent: Intent,
  giver: GiverState,
  config: ValidateConfig,
): ValidateResult {
  if (!config.channels.includes(intent.channelId)) {
    return { kind: "ignore", reason: "channel_not_allowlisted" };
  }
  if (!giver.isActive) {
    return { kind: "ignore", reason: "giver_inactive" };
  }
  if (intent.tacoCount <= 0) {
    return { kind: "ignore", reason: "no_tacos" };
  }
  const recipients = [...new Set(intent.recipientIds)]
    .filter((r) => r !== intent.giverId)
    .sort();
  if (recipients.length === 0) {
    return { kind: "ignore", reason: "no_recipients" };
  }
  const totalDemand = intent.tacoCount * recipients.length;
  if (totalDemand > giver.dailyRemaining) {
    return { kind: "over_allowance", demand: totalDemand, remaining: giver.dailyRemaining };
  }
  return {
    kind: "ok",
    recipients,
    totalDemand,
    perRecipient: intent.tacoCount,
  };
}
```

- [ ] **Step 4: Re-run**

```bash
pnpm test tests/unit/give-validate.test.ts
```

Expected: 10 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(give): validate phase — pure rules, sorted recipients, all-or-nothing"
```

---

## Task 17: Give pipeline — `decide` phase (TDD)

**Files:**
- Modify: `lib/slack/give.ts`
- Create: `tests/unit/give-decide.test.ts`

The decide phase converts a successful validation into a concrete Plan: per-recipient amounts, per-recipient idempotency keys, a single giver decrement.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/give-decide.test.ts
import { describe, expect, test } from "vitest";
import { decide } from "@/lib/slack/give";

describe("decide", () => {
  test("produces one row per recipient with correct amount", () => {
    const plan = decide({
      giverId: "U_G",
      recipients: ["U_A", "U_B"],
      perRecipient: 2,
      totalDemand: 4,
      channelId: "C",
      channelTs: "1700.0",
      envelopeEventId: "Ev42",
    });
    expect(plan.giverDecrement).toBe(4);
    expect(plan.transactions).toHaveLength(2);
    expect(plan.transactions[0]).toMatchObject({
      toUserId: "U_A",
      fromUserId: "U_G",
      amount: 2,
      slackEventId: "Ev42-0",
    });
    expect(plan.transactions[1]).toMatchObject({
      toUserId: "U_B",
      slackEventId: "Ev42-1",
    });
  });

  test("preserves recipient order so the index is stable", () => {
    const plan = decide({
      giverId: "U_G",
      recipients: ["U_A", "U_B", "U_C"],
      perRecipient: 1,
      totalDemand: 3,
      channelId: "C",
      channelTs: "1.0",
      envelopeEventId: "Ev",
    });
    expect(plan.transactions.map((t) => t.slackEventId)).toEqual(["Ev-0", "Ev-1", "Ev-2"]);
  });
});
```

- [ ] **Step 2: Run; expect failure**

```bash
pnpm test tests/unit/give-decide.test.ts
```

Expected: FAIL — `decide` not exported.

- [ ] **Step 3: Append decide to lib/slack/give.ts**

```ts
export type DecideInput = {
  giverId: string;
  recipients: string[];
  perRecipient: number;
  totalDemand: number;
  channelId: string;
  channelTs: string;
  envelopeEventId: string;
  reason?: string | null;
};

export type PlannedTransaction = {
  toUserId: string;
  fromUserId: string;
  amount: number;
  slackEventId: string;
  slackChannelId: string;
  slackMessageTs: string;
  reason: string | null;
};

export type GivePlan = {
  giverId: string;
  giverDecrement: number;
  transactions: PlannedTransaction[];
};

export function decide(input: DecideInput): GivePlan {
  const transactions: PlannedTransaction[] = input.recipients.map((rid, idx) => ({
    toUserId: rid,
    fromUserId: input.giverId,
    amount: input.perRecipient,
    slackEventId: `${input.envelopeEventId}-${idx}`,
    slackChannelId: input.channelId,
    slackMessageTs: input.channelTs,
    reason: input.reason ?? null,
  }));
  return {
    giverId: input.giverId,
    giverDecrement: input.totalDemand,
    transactions,
  };
}
```

- [ ] **Step 4: Re-run**

```bash
pnpm test tests/unit/give-decide.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(give): decide phase produces per-recipient idempotent transaction plan"
```

---

# Phase 7 — Give Pipeline Execution

## Task 18: User upsert helper (integration test)

**Files:**
- Create: `lib/db/queries.ts`, `tests/integration/users-upsert.test.ts`

We need a single helper to ensure a user row exists before any give. Slack provides their ID and (if we look them up) their display name.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/users-upsert.test.ts
import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, inRollbackTx } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";

test("upsertUser inserts a new user with default daily allowance", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_NEW", name: "Alice", dailyAllowance: 5 });
    const [row] = await tx.select().from(users).where(eq(users.id, "U_NEW"));
    expect(row).toBeDefined();
    expect(row.dailyRemaining).toBe(5);
    expect(row.receivedTotal).toBe(0);
    expect(row.balance).toBe(0);
    expect(row.isActive).toBe(true);
  });
});

test("upsertUser refreshes name on existing user without resetting counters", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_E", name: "Old", dailyAllowance: 5 });
    await tx.update(users)
      .set({ receivedTotal: 7, balance: 7, dailyRemaining: 2 })
      .where(eq(users.id, "U_E"));
    await upsertUser(tx, { id: "U_E", name: "New", dailyAllowance: 5 });
    const [row] = await tx.select().from(users).where(eq(users.id, "U_E"));
    expect(row.name).toBe("New");
    expect(row.receivedTotal).toBe(7);
    expect(row.balance).toBe(7);
    expect(row.dailyRemaining).toBe(2);
  });
});

afterAll(async () => {
  await closePool();
});
```

- [ ] **Step 2: Run; expect failure**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/users-upsert.test.ts
```

Expected: FAIL — `upsertUser` not exported.

- [ ] **Step 3: Create lib/db/queries.ts**

```ts
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { users } from "./schema";

export async function upsertUser(
  db: DB,
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
```

- [ ] **Step 4: Re-run**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/users-upsert.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): upsertUser preserves counters on subsequent inserts"
```

---

## Task 19: `executeGive` — atomic single-recipient give

**Files:**
- Create: `lib/slack/execute.ts`, `tests/integration/give-execute.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/give-execute.test.ts
import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, inRollbackTx } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { executeGive } from "@/lib/slack/execute";
import { users, transactions } from "@/lib/db/schema";

test("executeGive decrements giver, increments receiver, writes transaction", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });

    const result = await executeGive(tx, {
      giverId: "U_G",
      giverDecrement: 1,
      transactions: [{
        toUserId: "U_R",
        fromUserId: "U_G",
        amount: 1,
        slackEventId: "Ev1-0",
        slackChannelId: "C",
        slackMessageTs: "1.0",
        reason: "thanks",
      }],
    });

    expect(result.kind).toBe("ok");
    const [g] = await tx.select().from(users).where(eq(users.id, "U_G"));
    const [r] = await tx.select().from(users).where(eq(users.id, "U_R"));
    expect(g.dailyRemaining).toBe(4);
    expect(r.receivedTotal).toBe(1);
    expect(r.balance).toBe(1);

    const txns = await tx.select().from(transactions);
    expect(txns).toHaveLength(1);
    expect(txns[0].slackEventId).toBe("Ev1-0");
  });
});

test("executeGive returns over_allowance and rolls back when giver lacks tacos", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await tx.update(users).set({ dailyRemaining: 0 }).where(eq(users.id, "U_G"));
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });

    const result = await executeGive(tx, {
      giverId: "U_G",
      giverDecrement: 1,
      transactions: [{
        toUserId: "U_R",
        fromUserId: "U_G",
        amount: 1,
        slackEventId: "Ev2-0",
        slackChannelId: "C",
        slackMessageTs: "2.0",
        reason: null,
      }],
    });

    expect(result.kind).toBe("over_allowance");
    const txns = await tx.select().from(transactions);
    expect(txns).toHaveLength(0);
    const [r] = await tx.select().from(users).where(eq(users.id, "U_R"));
    expect(r.receivedTotal).toBe(0);
  });
});

afterAll(async () => {
  await closePool();
});
```

- [ ] **Step 2: Run; expect failure**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/give-execute.test.ts
```

Expected: FAIL — `executeGive` not exported.

- [ ] **Step 3: Create lib/slack/execute.ts**

```ts
import { and, eq, gte, sql } from "drizzle-orm";
import type { DB } from "@/lib/db/client";
import { transactions, users } from "@/lib/db/schema";
import type { GivePlan } from "./give";

export type ExecuteResult =
  | { kind: "ok" }
  | { kind: "over_allowance" }
  | { kind: "duplicate" };

export async function executeGive(db: DB, plan: GivePlan): Promise<ExecuteResult> {
  return db.transaction(async (tx) => {
    const decremented = await tx
      .update(users)
      .set({
        dailyRemaining: sql`${users.dailyRemaining} - ${plan.giverDecrement}`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(users.id, plan.giverId), gte(users.dailyRemaining, plan.giverDecrement)))
      .returning({ id: users.id });

    if (decremented.length === 0) {
      // Will rollback on return.
      return { kind: "over_allowance" } as const;
    }

    for (const t of plan.transactions) {
      await tx
        .update(users)
        .set({
          receivedTotal: sql`${users.receivedTotal} + ${t.amount}`,
          balance: sql`${users.balance} + ${t.amount}`,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, t.toUserId));

      const inserted = await tx
        .insert(transactions)
        .values({
          type: "give",
          toUserId: t.toUserId,
          fromUserId: t.fromUserId,
          amount: t.amount,
          reason: t.reason,
          slackEventId: t.slackEventId,
          slackChannelId: t.slackChannelId,
          slackMessageTs: t.slackMessageTs,
        })
        .onConflictDoNothing({ target: transactions.slackEventId })
        .returning({ id: transactions.id });

      if (inserted.length === 0) {
        // Duplicate event_id → Slack retry. Roll back the whole transaction
        // so the receiver counters are not double-applied.
        throw new DuplicateGiveError();
      }
    }

    return { kind: "ok" } as const;
  }).catch((err) => {
    if (err instanceof DuplicateGiveError) return { kind: "duplicate" } as const;
    throw err;
  });
}

class DuplicateGiveError extends Error {
  constructor() { super("duplicate"); }
}
```

- [ ] **Step 4: Re-run**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/give-execute.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(give): executeGive — atomic giver decrement + receiver credit + transaction insert"
```

---

## Task 20: `executeGive` — multi-recipient batch

**Files:**
- Modify: `tests/integration/give-execute.test.ts`

Multi-recipient should be all-or-nothing.

- [ ] **Step 1: Append failing test**

```ts
test("executeGive credits all recipients atomically", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_A", name: "A", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_B", name: "B", dailyAllowance: 5 });

    const result = await executeGive(tx, {
      giverId: "U_G",
      giverDecrement: 4, // 2 each
      transactions: [
        { toUserId: "U_A", fromUserId: "U_G", amount: 2, slackEventId: "Ev3-0",
          slackChannelId: "C", slackMessageTs: "3.0", reason: null },
        { toUserId: "U_B", fromUserId: "U_G", amount: 2, slackEventId: "Ev3-1",
          slackChannelId: "C", slackMessageTs: "3.0", reason: null },
      ],
    });

    expect(result.kind).toBe("ok");
    const [g] = await tx.select().from(users).where(eq(users.id, "U_G"));
    const [a] = await tx.select().from(users).where(eq(users.id, "U_A"));
    const [b] = await tx.select().from(users).where(eq(users.id, "U_B"));
    expect(g.dailyRemaining).toBe(1);
    expect(a.balance).toBe(2);
    expect(b.balance).toBe(2);
    const txns = await tx.select().from(transactions);
    expect(txns).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/give-execute.test.ts
```

Expected: 3 passing (the new test should pass without further code changes — `executeGive` already loops).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(give): cover multi-recipient batch credit"
```

---

## Task 21: Idempotency on duplicate Slack event ID

**Files:**
- Modify: `tests/integration/give-execute.test.ts`

- [ ] **Step 1: Append failing test**

```ts
test("executeGive returns duplicate and does not re-credit on retry", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_G", name: "G", dailyAllowance: 5 });
    await upsertUser(tx, { id: "U_R", name: "R", dailyAllowance: 5 });

    const plan = {
      giverId: "U_G",
      giverDecrement: 1,
      transactions: [{
        toUserId: "U_R", fromUserId: "U_G", amount: 1,
        slackEventId: "Ev_DUP-0", slackChannelId: "C", slackMessageTs: "1.0",
        reason: null,
      }],
    };

    const first = await executeGive(tx, plan);
    expect(first.kind).toBe("ok");

    const second = await executeGive(tx, plan);
    expect(second.kind).toBe("duplicate");

    const [g] = await tx.select().from(users).where(eq(users.id, "U_G"));
    const [r] = await tx.select().from(users).where(eq(users.id, "U_R"));
    expect(g.dailyRemaining).toBe(4);   // not 3
    expect(r.balance).toBe(1);          // not 2

    const txns = await tx.select().from(transactions);
    expect(txns).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/give-execute.test.ts
```

Expected: 4 passing — `executeGive` already throws `DuplicateGiveError` on conflict, which rolls back the transaction.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(give): cover Slack-retry idempotency via slack_event_id UNIQUE"
```

---

## Task 22: Concurrency — two parallel gives racing past the cap

**Files:**
- Create: `tests/integration/give-concurrency.test.ts`

This test cannot use `inRollbackTx` (the rollback helper holds a single connection). We need two separate connections actually contending.

- [ ] **Step 1: Add a separate helper**

Append to `tests/integration/helpers/db.ts`:

```ts
export async function withCleanDb<T>(fn: (db: TestDB) => Promise<T>): Promise<T> {
  // Truncate before/after to isolate from other tests.
  await pool.query("TRUNCATE TABLE transactions, items, users RESTART IDENTITY CASCADE");
  try {
    return await fn(testDb);
  } finally {
    await pool.query("TRUNCATE TABLE transactions, items, users RESTART IDENTITY CASCADE");
  }
}
```

- [ ] **Step 2: Write the concurrency test**

```ts
// tests/integration/give-concurrency.test.ts
import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, withCleanDb } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { executeGive } from "@/lib/slack/execute";
import { users, transactions } from "@/lib/db/schema";

test("two parallel gives totaling more than allowance: only the fitting one succeeds", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_G", name: "G", dailyAllowance: 1 });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_B", name: "B", dailyAllowance: 5 });

    const planA = {
      giverId: "U_G", giverDecrement: 1,
      transactions: [{ toUserId: "U_A", fromUserId: "U_G", amount: 1,
        slackEventId: "EvA-0", slackChannelId: "C", slackMessageTs: "A", reason: null }],
    };
    const planB = {
      giverId: "U_G", giverDecrement: 1,
      transactions: [{ toUserId: "U_B", fromUserId: "U_G", amount: 1,
        slackEventId: "EvB-0", slackChannelId: "C", slackMessageTs: "B", reason: null }],
    };

    const [resA, resB] = await Promise.all([
      executeGive(db, planA),
      executeGive(db, planB),
    ]);

    const successes = [resA, resB].filter((r) => r.kind === "ok").length;
    const overs = [resA, resB].filter((r) => r.kind === "over_allowance").length;
    expect(successes).toBe(1);
    expect(overs).toBe(1);

    const [g] = await db.select().from(users).where(eq(users.id, "U_G"));
    expect(g.dailyRemaining).toBe(0);

    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(1);
  });
});

afterAll(async () => {
  await closePool();
});
```

- [ ] **Step 3: Run**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/give-concurrency.test.ts
```

Expected: 1 passing — only one of the two parallel updates can satisfy `WHERE daily_remaining >= 1` after the first commits.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(give): cover concurrent gives racing past the allowance cap"
```

---

## Task 23: CHECK constraints actually fire

**Files:**
- Create: `tests/integration/constraints.test.ts`

- [ ] **Step 1: Write tests**

```ts
// tests/integration/constraints.test.ts
import { afterAll, expect, test } from "vitest";
import { closePool, inRollbackTx } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { transactions, users, items } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

test("self-give insert is rejected by CHECK constraint", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_S", name: "S", dailyAllowance: 5 });
    await expect(
      tx.insert(transactions).values({
        type: "give", fromUserId: "U_S", toUserId: "U_S",
        amount: 1, slackEventId: "self",
      }),
    ).rejects.toThrow(/transactions_shape_and_rule|check constraint/i);
  });
});

test("daily_remaining cannot be set negative", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_N", name: "N", dailyAllowance: 5 });
    await expect(
      tx.execute(sql`UPDATE users SET daily_remaining = -1 WHERE id = 'U_N'`),
    ).rejects.toThrow(/users_daily_remaining_nonneg|check constraint/i);
  });
});

test("balance cannot exceed received_total", async () => {
  await inRollbackTx(async (tx) => {
    await upsertUser(tx, { id: "U_X", name: "X", dailyAllowance: 5 });
    await expect(
      tx.execute(sql`UPDATE users SET balance = 10 WHERE id = 'U_X'`),
    ).rejects.toThrow(/users_balance_le_received|check constraint/i);
  });
});

test("zero-price item rejected", async () => {
  await inRollbackTx(async (tx) => {
    await expect(
      tx.insert(items).values({ name: "Free", priceTacos: 0 }),
    ).rejects.toThrow(/items_price_positive|check constraint/i);
  });
});

afterAll(async () => {
  await closePool();
});
```

- [ ] **Step 2: Run**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/constraints.test.ts
```

Expected: 4 passing.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(constraints): verify DB CHECK constraints actually reject violations"
```

---

## Task 24: Wire the give pipeline into the Bolt `message` handler

**Files:**
- Create: `lib/slack/handlers/message.ts`, `lib/slack/handlers.ts` (replace stub)
- Create: `lib/slack/botUserId.ts`, `lib/slack/format.ts`

- [ ] **Step 1: Create lib/slack/botUserId.ts**

```ts
import { boltApp } from "./bolt";
import { config } from "@/lib/config";

let cached: string | undefined = config.slack.botUserId;
let inflight: Promise<string> | undefined;

export async function getBotUserId(): Promise<string> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await boltApp.client.auth.test({ token: config.slack.botToken });
    if (!res.user_id) throw new Error("auth.test returned no user_id");
    cached = res.user_id;
    return cached;
  })();
  try {
    return await inflight;
  } finally {
    inflight = undefined;
  }
}
```

- [ ] **Step 2: Create lib/slack/format.ts**

```ts
export function overAllowanceMessage(demand: number, remaining: number): string {
  return `🌮 You've only got ${remaining} taco${remaining === 1 ? "" : "s"} left today; that would need ${demand}. Try again tomorrow.`;
}
```

- [ ] **Step 3: Create lib/slack/handlers/message.ts**

```ts
import type { App } from "@slack/bolt";
import { db } from "@/lib/db/client";
import { upsertUser } from "@/lib/db/queries";
import { config } from "@/lib/config";
import { decide, validate, type GiverState } from "../give";
import { executeGive } from "../execute";
import { countTacos, findUserIds } from "../parser";
import { getBotUserId } from "../botUserId";
import { overAllowanceMessage } from "../format";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";

export function registerMessageHandler(app: App) {
  app.event("message", async ({ event, client }) => {
    // Bolt types `event` as a union; narrow to plain message events.
    if (event.subtype === "message_changed" || event.subtype === "message_deleted") return;
    // bot_id is set on bot-authored messages (including ours).
    if ("bot_id" in event && event.bot_id) return;
    // Only handle public-channel messages here.
    if (event.channel_type !== "channel") return;

    const text = "text" in event ? event.text ?? "" : "";
    const tacoCount = countTacos(text);
    if (tacoCount === 0) return;

    const channelId = event.channel;
    if (!config.taco.channels.includes(channelId)) return;

    const giverId = "user" in event ? event.user : undefined;
    if (!giverId) return;

    const botId = await getBotUserId();
    const recipientIds = findUserIds(text).filter((u) => u !== botId);
    if (recipientIds.length === 0) return;

    // Lazy-upsert giver and recipients.
    await upsertUser(db, { id: giverId, name: giverId, dailyAllowance: config.taco.dailyAllowance });
    for (const r of recipientIds) {
      await upsertUser(db, { id: r, name: r, dailyAllowance: config.taco.dailyAllowance });
    }

    const [giverRow] = await db.select().from(users).where(eq(users.id, giverId));
    const giver: GiverState = {
      id: giverRow.id,
      isActive: giverRow.isActive,
      dailyRemaining: giverRow.dailyRemaining,
    };

    const v = validate(
      {
        giverId,
        recipientIds,
        tacoCount,
        channelId,
        slackEventId: event.event_ts,            // narrowed below
        channelTs: event.ts,
      },
      giver,
      { channels: config.taco.channels, dailyAllowance: config.taco.dailyAllowance },
    );

    if (v.kind === "ignore") return;
    if (v.kind === "over_allowance") {
      await client.chat.postEphemeral({
        channel: channelId,
        user: giverId,
        text: overAllowanceMessage(v.demand, v.remaining),
      });
      return;
    }

    const plan = decide({
      giverId,
      recipients: v.recipients,
      perRecipient: v.perRecipient,
      totalDemand: v.totalDemand,
      channelId,
      channelTs: event.ts,
      envelopeEventId: event.event_ts,
      reason: text,
    });

    const result = await executeGive(db, plan);
    if (result.kind === "over_allowance") {
      await client.chat.postEphemeral({
        channel: channelId,
        user: giverId,
        text: overAllowanceMessage(plan.giverDecrement, giver.dailyRemaining),
      });
      return;
    }

    if (result.kind === "ok") {
      // Visual ack; failure is non-fatal.
      try {
        await client.reactions.add({
          channel: channelId,
          timestamp: event.ts,
          name: "taco",
        });
      } catch (err) {
        console.warn("[reactions.add] failed", err);
      }
    }
  });
}
```

> **Note on `event.event_ts` vs `body.event_id`:** Bolt's `event` argument is the inner `event` object from the Slack envelope. The envelope-level `event_id` is on `body`, not `event`. If Task 11's research surfaced a way to access the envelope `event_id` from a Bolt handler, prefer that. Otherwise `event.event_ts` (which is unique per event for a given workspace) is acceptable as the idempotency seed.

- [ ] **Step 4: Replace lib/slack/handlers.ts**

```ts
import { boltApp } from "./bolt";
import { registerMessageHandler } from "./handlers/message";

registerMessageHandler(boltApp);
```

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Run all tests**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test
```

Expected: all prior tests still pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(slack): wire message-typed give pipeline end-to-end"
```

---

# Phase 8 — Reactions

## Task 25: `reaction_added` handler with full integration test

**Files:**
- Create: `lib/slack/handlers/reaction.ts`, `tests/integration/reaction-give.test.ts`
- Modify: `lib/slack/handlers.ts`

For reactions we look up the message author via `conversations.history`. We can't easily integration-test the Slack client; the test below seeds DB state and calls a pure-function variant that takes the resolved author as input.

- [ ] **Step 1: Extract a pure `processReaction` core**

Create `lib/slack/handlers/reaction.ts`:

```ts
import type { App } from "@slack/bolt";
import { db } from "@/lib/db/client";
import { upsertUser } from "@/lib/db/queries";
import { config } from "@/lib/config";
import { decide, validate, type GiverState } from "../give";
import { executeGive } from "../execute";
import { getBotUserId } from "../botUserId";
import { overAllowanceMessage } from "../format";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";
import type { DB } from "@/lib/db/client";

export type ReactionInput = {
  reactor: string;
  author: string;
  channelId: string;
  messageTs: string;
};

export type ReactionOutcome =
  | { kind: "ok" }
  | { kind: "ignore"; reason: string }
  | { kind: "over_allowance"; demand: number; remaining: number };

export async function processReaction(
  database: DB,
  input: ReactionInput,
): Promise<ReactionOutcome> {
  if (!config.taco.channels.includes(input.channelId)) {
    return { kind: "ignore", reason: "channel_not_allowlisted" };
  }
  const botId = await getBotUserId();
  if (input.author === botId || input.author === input.reactor) {
    return { kind: "ignore", reason: "self_or_bot" };
  }

  await upsertUser(database, { id: input.reactor, name: input.reactor, dailyAllowance: config.taco.dailyAllowance });
  await upsertUser(database, { id: input.author, name: input.author, dailyAllowance: config.taco.dailyAllowance });

  const [reactorRow] = await database.select().from(users).where(eq(users.id, input.reactor));
  if (!reactorRow.isActive) return { kind: "ignore", reason: "reactor_inactive" };

  const giver: GiverState = {
    id: reactorRow.id,
    isActive: reactorRow.isActive,
    dailyRemaining: reactorRow.dailyRemaining,
  };

  const v = validate(
    {
      giverId: input.reactor,
      recipientIds: [input.author],
      tacoCount: 1,
      channelId: input.channelId,
      slackEventId: `react-${input.channelId}-${input.messageTs}-${input.reactor}`,
      channelTs: input.messageTs,
    },
    giver,
    { channels: config.taco.channels, dailyAllowance: config.taco.dailyAllowance },
  );

  if (v.kind === "ignore") return v;
  if (v.kind === "over_allowance") return v;

  const plan = decide({
    giverId: input.reactor,
    recipients: v.recipients,
    perRecipient: v.perRecipient,
    totalDemand: v.totalDemand,
    channelId: input.channelId,
    channelTs: input.messageTs,
    envelopeEventId: `react-${input.channelId}-${input.messageTs}-${input.reactor}`,
    reason: "reaction",
  });

  const result = await executeGive(database, plan);
  if (result.kind === "over_allowance") {
    return { kind: "over_allowance", demand: plan.giverDecrement, remaining: giver.dailyRemaining };
  }
  return { kind: "ok" };
}

export function registerReactionHandler(app: App) {
  app.event("reaction_added", async ({ event, client }) => {
    if (event.reaction !== "taco") return;
    if (event.item.type !== "message") return;
    if (!config.taco.channels.includes(event.item.channel)) return;

    // Resolve author via conversations.history.
    let author: string | undefined;
    try {
      const res = await client.conversations.history({
        channel: event.item.channel,
        latest: event.item.ts,
        oldest: event.item.ts,
        inclusive: true,
        limit: 1,
      });
      author = res.messages?.[0]?.user;
    } catch (err) {
      console.warn("[conversations.history] failed", err);
      return;
    }
    if (!author) return;

    const outcome = await processReaction(db, {
      reactor: event.user,
      author,
      channelId: event.item.channel,
      messageTs: event.item.ts,
    });

    if (outcome.kind === "over_allowance") {
      await client.chat.postEphemeral({
        channel: event.item.channel,
        user: event.user,
        text: overAllowanceMessage(outcome.demand, outcome.remaining),
      });
    }
  });
}
```

- [ ] **Step 2: Register the reaction handler**

Modify `lib/slack/handlers.ts`:

```ts
import { boltApp } from "./bolt";
import { registerMessageHandler } from "./handlers/message";
import { registerReactionHandler } from "./handlers/reaction";

registerMessageHandler(boltApp);
registerReactionHandler(boltApp);
```

- [ ] **Step 3: Write the integration test**

```ts
// tests/integration/reaction-give.test.ts
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { closePool, withCleanDb } from "./helpers/db";
import { processReaction } from "@/lib/slack/handlers/reaction";
import { upsertUser } from "@/lib/db/queries";
import { transactions, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

vi.mock("@/lib/config", () => ({
  config: {
    taco: { channels: ["C_TAQ"], dailyAllowance: 5 },
    slack: { botUserId: "U_BOT" },
    admin: { slackIds: [] },
    shopUrl: "/shop",
  },
}));

vi.mock("@/lib/slack/botUserId", () => ({
  getBotUserId: async () => "U_BOT",
}));

beforeEach(() => vi.clearAllMocks());

test("reaction give credits the message author", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: 5 });

    const out = await processReaction(db, {
      reactor: "U_R", author: "U_A", channelId: "C_TAQ", messageTs: "1700.0",
    });

    expect(out.kind).toBe("ok");
    const [a] = await db.select().from(users).where(eq(users.id, "U_A"));
    expect(a.balance).toBe(1);

    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(1);
    expect(txns[0].slackEventId).toBe("react-C_TAQ-1700.0-U_R-0");
  });
});

test("self-reaction is ignored", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_X", name: "X", dailyAllowance: 5 });
    const out = await processReaction(db, {
      reactor: "U_X", author: "U_X", channelId: "C_TAQ", messageTs: "1.0",
    });
    expect(out.kind).toBe("ignore");
  });
});

test("reaction outside allowlisted channel is ignored", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_R", name: "R", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_A", name: "A", dailyAllowance: 5 });
    const out = await processReaction(db, {
      reactor: "U_R", author: "U_A", channelId: "C_OTHER", messageTs: "1.0",
    });
    expect(out.kind).toBe("ignore");
  });
});

afterAll(async () => {
  await closePool();
});
```

- [ ] **Step 4: Run the tests**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/reaction-give.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(slack): reaction_added handler with extracted pure core for testability"
```

---

# Phase 9 — Commands

## Task 26: Command router & first command (`score`)

**Files:**
- Create: `lib/slack/handlers/commands.ts`
- Modify: `lib/slack/handlers.ts`

- [ ] **Step 1: Create commands handler with score**

```ts
// lib/slack/handlers/commands.ts
import type { App } from "@slack/bolt";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { config } from "@/lib/config";

const COMMAND_RE = {
  score: /\b(score|ranking|leaderboard)\b/i,
  left: /\b(left|how many|how much|combien)\b/i,
  balance: /\b(balance|wallet)\b/i,
  shop: /\b(shop|boutique)\b/i,
  help: /\b(help|aide|commandes)\b/i,
} as const;

async function topReceivers(limit = 5) {
  return db
    .select({ name: users.name, received: users.receivedTotal })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(desc(users.receivedTotal))
    .limit(limit);
}

function formatScore(rows: { name: string; received: number }[]): string {
  if (rows.length === 0) return "🌮 No tacos given yet — be the first!";
  const lines = rows.map((r, i) => `${i + 1}. ${r.name} — ${r.received} 🌮`);
  return ["*Top taco receivers (lifetime)*", ...lines].join("\n");
}

async function dispatch(text: string, userId: string): Promise<string | null> {
  const t = text.trim();
  if (COMMAND_RE.score.test(t)) {
    const rows = await topReceivers();
    return formatScore(rows);
  }
  // Other commands added in subsequent tasks.
  return null;
}

export function registerCommandHandlers(app: App) {
  app.event("app_mention", async ({ event, client }) => {
    const reply = await dispatch(event.text, event.user ?? "");
    if (reply) {
      await client.chat.postMessage({ channel: event.channel, text: reply, thread_ts: event.thread_ts ?? event.ts });
    }
  });

  app.event("message", async ({ event, client }) => {
    if (event.channel_type !== "im") return;
    if (event.subtype === "message_changed" || event.subtype === "message_deleted") return;
    if ("bot_id" in event && event.bot_id) return;
    const text = "text" in event ? event.text ?? "" : "";
    const userId = "user" in event ? event.user : undefined;
    if (!userId) return;
    const reply = await dispatch(text, userId);
    if (reply) await client.chat.postMessage({ channel: event.channel, text: reply });
  });
}

// Export for tests
export const __test = { dispatch, COMMAND_RE };
```

- [ ] **Step 2: Register in handlers**

Modify `lib/slack/handlers.ts`:

```ts
import { boltApp } from "./bolt";
import { registerMessageHandler } from "./handlers/message";
import { registerReactionHandler } from "./handlers/reaction";
import { registerCommandHandlers } from "./handlers/commands";

registerMessageHandler(boltApp);
registerReactionHandler(boltApp);
registerCommandHandlers(boltApp);
```

- [ ] **Step 3: Note about the message-handler conflict**

The `message` event listener registered in `handlers/message.ts` only processes `channel_type === "channel"`. The new commands listener filters to `channel_type === "im"`. Both subscribe to `message`, but Bolt's event registry calls all handlers; the channel-type filter prevents double-processing. Confirm in `lib/slack/handlers/message.ts` that the early return is `if (event.channel_type !== "channel") return;`.

- [ ] **Step 4: Write integration test for score**

```ts
// tests/integration/command-score.test.ts
import { afterAll, expect, test, vi } from "vitest";
import { closePool, withCleanDb } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { __test } from "@/lib/slack/handlers/commands";
import { sql } from "drizzle-orm";

vi.mock("@/lib/config", () => ({
  config: {
    taco: { channels: ["C_TAQ"], dailyAllowance: 5 },
    slack: { botUserId: "U_BOT" },
    admin: { slackIds: [] },
    shopUrl: "/shop",
  },
}));

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
```

- [ ] **Step 5: Run**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/command-score.test.ts
```

Expected: 1 passing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(slack): commands router + score command (top 5 by lifetime received)"
```

---

## Task 27: `left`, `balance`, `shop`, `help` commands

**Files:**
- Modify: `lib/slack/handlers/commands.ts`, `tests/integration/command-score.test.ts`

- [ ] **Step 1: Extend dispatch**

In `lib/slack/handlers/commands.ts`, replace the body of `dispatch` and add helpers:

```ts
const HELP_TEXT = `🌮 *Tacobot commands*
• \`score\`/\`ranking\` — top 5 taco receivers
• \`balance\`/\`wallet\` — what you can spend in the shop
• \`left\`/\`how many\`/\`combien\` — tacos you have left to give today
• \`shop\`/\`boutique\` — shop URL
• \`help\`/\`aide\`/\`commandes\` — this message

To give a taco, type \`@person :taco:\` in #taqueria, or react to their message with 🌮.`;

async function dispatch(text: string, userId: string): Promise<string | null> {
  const t = text.trim();
  if (COMMAND_RE.score.test(t)) {
    const rows = await topReceivers();
    return formatScore(rows);
  }
  if (COMMAND_RE.left.test(t)) {
    const [u] = await db.select({ left: users.dailyRemaining }).from(users).where(eq(users.id, userId));
    if (!u) return `You have ${config.taco.dailyAllowance} tacos left to give today.`;
    return `You have ${u.left} taco${u.left === 1 ? "" : "s"} left to give today.`;
  }
  if (COMMAND_RE.balance.test(t)) {
    const [u] = await db.select({ balance: users.balance }).from(users).where(eq(users.id, userId));
    const bal = u?.balance ?? 0;
    return `You have ${bal} taco${bal === 1 ? "" : "s"} to spend. Browse the shop: ${config.shopUrl}`;
  }
  if (COMMAND_RE.shop.test(t)) {
    return `Shop: ${config.shopUrl}`;
  }
  if (COMMAND_RE.help.test(t)) {
    return HELP_TEXT;
  }
  return null;
}
```

- [ ] **Step 2: Add tests for each**

Append to `tests/integration/command-score.test.ts`:

```ts
test("left command reports caller's daily_remaining", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_X", name: "X", dailyAllowance: 5 });
    await db.execute(sql`UPDATE users SET daily_remaining = 3 WHERE id = 'U_X'`);
    const reply = await __test.dispatch("how many", "U_X");
    expect(reply).toContain("3");
  });
});

test("balance command reports caller's balance", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_X", name: "X", dailyAllowance: 5 });
    await db.execute(sql`UPDATE users SET received_total = 7, balance = 7 WHERE id = 'U_X'`);
    const reply = await __test.dispatch("balance", "U_X");
    expect(reply).toContain("7 tacos to spend");
  });
});

test("shop command returns the shop URL", async () => {
  const reply = await __test.dispatch("shop", "U_X");
  expect(reply).toContain("/shop");
});

test("help command returns the full help text", async () => {
  const reply = await __test.dispatch("help", "U_X");
  expect(reply).toContain("Tacobot commands");
  expect(reply).toContain("score");
  expect(reply).toContain("balance");
});

test("French synonyms work: aide, combien, boutique, commandes", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_X", name: "X", dailyAllowance: 5 });
    expect(await __test.dispatch("aide", "U_X")).toContain("Tacobot");
    expect(await __test.dispatch("combien", "U_X")).toContain("today");
    expect(await __test.dispatch("boutique", "U_X")).toContain("/shop");
    expect(await __test.dispatch("commandes", "U_X")).toContain("Tacobot");
  });
});
```

- [ ] **Step 3: Run**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/command-score.test.ts
```

Expected: 6 passing total.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(slack): left/balance/shop/help commands incl. French synonyms"
```

---

# Phase 10 — User Sync

## Task 28: `team_join` and `user_change` handlers

**Files:**
- Create: `lib/slack/handlers/userSync.ts`
- Modify: `lib/slack/handlers.ts`

- [ ] **Step 1: Create the handler**

```ts
// lib/slack/handlers/userSync.ts
import type { App } from "@slack/bolt";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { upsertUser } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";
import { config } from "@/lib/config";

function pickName(u: { profile?: { display_name?: string; real_name?: string }; name?: string }): string {
  const dn = u.profile?.display_name?.trim();
  if (dn) return dn;
  const rn = u.profile?.real_name?.trim();
  if (rn) return rn;
  return u.name ?? "unknown";
}

export function registerUserSyncHandlers(app: App) {
  app.event("team_join", async ({ event }) => {
    const u = event.user;
    if (!u || u.is_bot || u.deleted) return;
    await upsertUser(db, {
      id: u.id,
      name: pickName(u),
      dailyAllowance: config.taco.dailyAllowance,
    });
  });

  app.event("user_change", async ({ event }) => {
    const u = event.user;
    if (!u) return;
    if (u.is_bot) return;

    if (u.deleted) {
      await db.update(users).set({ isActive: false }).where(eq(users.id, u.id));
      return;
    }
    await upsertUser(db, {
      id: u.id,
      name: pickName(u),
      dailyAllowance: config.taco.dailyAllowance,
    });
  });
}
```

- [ ] **Step 2: Register**

```ts
// lib/slack/handlers.ts
import { boltApp } from "./bolt";
import { registerMessageHandler } from "./handlers/message";
import { registerReactionHandler } from "./handlers/reaction";
import { registerCommandHandlers } from "./handlers/commands";
import { registerUserSyncHandlers } from "./handlers/userSync";

registerMessageHandler(boltApp);
registerReactionHandler(boltApp);
registerCommandHandlers(boltApp);
registerUserSyncHandlers(boltApp);
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(slack): team_join + user_change handlers keep users table fresh"
```

---

## Task 29: `scripts/sync-users.ts` bootstrap

**Files:**
- Create: `scripts/sync-users.ts`

One-shot script: pages `users.list`, upserts everyone, deactivates anyone in DB but missing/deleted.

- [ ] **Step 1: Create the script**

```ts
// scripts/sync-users.ts
import { WebClient } from "@slack/web-api";
import { db } from "@/lib/db/client";
import { upsertUser } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";
import { config } from "@/lib/config";
import { eq, inArray, notInArray, sql } from "drizzle-orm";

async function main() {
  const client = new WebClient(config.slack.botToken);
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const res = await client.users.list({ limit: 200, cursor });
    pages++;
    if (!res.members) break;
    for (const m of res.members) {
      if (!m.id) continue;
      if (m.is_bot) continue;
      if (m.deleted) {
        if (m.id) {
          await db.update(users).set({ isActive: false }).where(eq(users.id, m.id));
        }
        continue;
      }
      const name =
        m.profile?.display_name?.trim() ||
        m.profile?.real_name?.trim() ||
        m.name ||
        m.id;
      await upsertUser(db, {
        id: m.id,
        name,
        dailyAllowance: config.taco.dailyAllowance,
      });
      seen.push(m.id);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Anyone in DB not seen this run is treated as inactive.
  if (seen.length > 0) {
    await db
      .update(users)
      .set({ isActive: false })
      .where(notInArray(users.id, seen));
  }

  console.log(`sync-users: ${pages} page(s), ${seen.length} active users`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Add the missing dep:

```bash
pnpm add @slack/web-api
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(scripts): sync-users with cursor pagination + inactive cleanup"
```

---

# Phase 11 — Daily Reset Cron

## Task 30: vercel.json + reset endpoint

**Files:**
- Create: `vercel.json`, `app/api/cron/reset-allowance/route.ts`
- Create: `tests/integration/cron-reset.test.ts`

- [ ] **Step 1: Create vercel.json**

```json
{
  "crons": [
    { "path": "/api/cron/reset-allowance", "schedule": "0 0 * * *" }
  ]
}
```

- [ ] **Step 2: Write the failing integration test (skipping HTTP layer; calls the handler logic directly)**

We extract the SQL into a function we can test, then the route handler just adds auth + calls it.

```ts
// tests/integration/cron-reset.test.ts
import { afterAll, expect, test, vi } from "vitest";
import { sql, eq } from "drizzle-orm";
import { closePool, withCleanDb } from "./helpers/db";
import { resetDailyAllowance } from "@/app/api/cron/reset-allowance/reset";
import { upsertUser } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";

vi.mock("@/lib/config", () => ({
  config: {
    taco: { channels: ["C_TAQ"], dailyAllowance: 5 },
    slack: {},
    admin: { slackIds: [] },
    shopUrl: "/shop",
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
```

- [ ] **Step 3: Run; expect failure**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/cron-reset.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the reset function**

```ts
// app/api/cron/reset-allowance/reset.ts
import { eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

export async function resetDailyAllowance(db: DB, allowance: number): Promise<number> {
  const result = await db
    .update(users)
    .set({ dailyRemaining: allowance, updatedAt: sql`now()` })
    .where(eq(users.isActive, true))
    .returning({ id: users.id });
  return result.length;
}
```

- [ ] **Step 5: Implement the route handler**

```ts
// app/api/cron/reset-allowance/route.ts
import { db } from "@/lib/db/client";
import { config } from "@/lib/config";
import { resetDailyAllowance } from "./reset";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!config.cronSecret || auth !== `Bearer ${config.cronSecret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const updated = await resetDailyAllowance(db, config.taco.dailyAllowance);
  return Response.json({ updated });
}

export async function GET(req: Request) {
  // Vercel Cron sends GET by default in some configurations.
  return POST(req);
}
```

- [ ] **Step 6: Re-run tests**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/cron-reset.test.ts
```

Expected: 2 passing.

- [ ] **Step 7: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(cron): daily allowance reset endpoint + Vercel Cron config"
```

---

# Phase 12 — Public Shop Page

## Task 31: Items query + `/shop` page

**Files:**
- Modify: `lib/db/queries.ts`
- Create: `app/shop/page.tsx`

- [ ] **Step 1: Add the listActiveItems query**

Append to `lib/db/queries.ts`:

```ts
import { asc, eq } from "drizzle-orm";
import { items } from "./schema";

export async function listActiveItems(db: DB) {
  return db
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
```

- [ ] **Step 2: Create the shop page**

```tsx
// app/shop/page.tsx
import { db } from "@/lib/db/client";
import { listActiveItems } from "@/lib/db/queries";

export const runtime = "nodejs";
export const revalidate = 60;

export default async function ShopPage() {
  const items = await listActiveItems(db);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">🌮 Tacobot Shop</h1>
        <p className="mt-2 text-gray-600">
          Earn tacos by being recognized in <code>#taqueria</code>. To redeem an item, DM HR with the item name.
          Check your balance by DMing <code>@tacobot</code> the word <code>balance</code>.
        </p>
      </header>

      {items.length === 0 ? (
        <p className="text-gray-500">No items available right now. Check back later.</p>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2">
          {items.map((it) => (
            <li key={it.id} className="rounded-lg border border-gray-200 p-4">
              {it.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.imageUrl} alt="" className="mb-3 h-40 w-full rounded object-cover" />
              ) : null}
              <div className="flex items-start justify-between gap-4">
                <h2 className="text-lg font-semibold">{it.name}</h2>
                <span className="whitespace-nowrap rounded bg-amber-100 px-2 py-1 text-sm font-medium text-amber-900">
                  {it.priceTacos} 🌮
                </span>
              </div>
              {it.description ? (
                <p className="mt-2 text-sm text-gray-600">{it.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 3: Manual smoke**

```bash
pnpm dev &
sleep 6
curl -fsSL http://localhost:3000/shop | grep -q "Tacobot Shop" && echo "OK"
kill %1 2>/dev/null
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(shop): public catalog page reading active items"
```

---

# Phase 13 — Auth.js + Admin Gate

## Task 32: Research Auth.js v5 Slack provider via context7

**Files:**
- Modify: `docs/bolt-app-router-notes.md` (append findings)

- [ ] **Step 1: Use context7 to fetch Auth.js v5 docs**

Resolve `next-auth` → library id. Query: "v5 Slack provider configuration sign-in callback JWT strategy".

- [ ] **Step 2: Verify the Slack provider import path**

In Auth.js v5 the provider lives at `next-auth/providers/slack`. Confirm via the fetched docs.

- [ ] **Step 3: Append findings to docs/bolt-app-router-notes.md**

```markdown
## Auth.js v5 Slack provider — verified pattern

(Filled in after context7 lookup. Capture: import path for the Slack provider,
session strategy config, signIn callback signature, how to read session in
Server Components / route handlers, middleware setup if any.)
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: capture verified Auth.js v5 + Slack provider pattern"
```

---

## Task 33: Auth.js config with Slack provider + allowlist

**Files:**
- Create: `lib/auth.ts`, `app/api/auth/[...nextauth]/route.ts`

- [ ] **Step 1: Create lib/auth.ts**

```ts
import NextAuth from "next-auth";
import Slack from "next-auth/providers/slack";
import { config as appConfig } from "@/lib/config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Slack({
      clientId: appConfig.slack.clientId,
      clientSecret: appConfig.slack.clientSecret,
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ profile }) {
      // Slack OIDC profile sets `sub` to the team-scoped user id; some apps
      // also expose `https://slack.com/user_id`. We check both.
      const slackUserId =
        (profile as Record<string, unknown> | undefined)?.["https://slack.com/user_id"] ??
        (profile as Record<string, unknown> | undefined)?.sub;
      if (typeof slackUserId !== "string") return false;
      return appConfig.admin.slackIds.includes(slackUserId);
    },
    async jwt({ token, profile }) {
      if (profile) {
        const slackUserId =
          (profile as Record<string, unknown>)["https://slack.com/user_id"] ??
          (profile as Record<string, unknown>).sub;
        if (typeof slackUserId === "string") token.slackUserId = slackUserId;
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.slackUserId === "string") {
        (session as { slackUserId?: string }).slackUserId = token.slackUserId;
      }
      return session;
    },
  },
});
```

- [ ] **Step 2: Wire up the route handler**

```ts
// app/api/auth/[...nextauth]/route.ts
export { GET, POST } from "@/lib/auth";
```

Wait — that's not quite right; Auth.js v5 exposes `handlers.GET` and `handlers.POST`. Use:

```ts
// app/api/auth/[...nextauth]/route.ts
import { handlers } from "@/lib/auth";
export const { GET, POST } = handlers;
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS. If `next-auth` types complain about the Slack provider profile shape, narrow with `// @ts-expect-error` and a comment explaining; don't write a wrong type assertion.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(auth): Auth.js v5 + Slack OIDC provider with admin allowlist"
```

---

## Task 34: `/admin` layout with auth gate

**Files:**
- Create: `app/admin/layout.tsx`, `app/admin/page.tsx`

- [ ] **Step 1: Create the layout**

```tsx
// app/admin/layout.tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn, signOut } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) {
    // Trigger Slack sign-in.
    redirect("/api/auth/signin?callbackUrl=/admin");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/admin" className="text-lg font-semibold">🌮 Tacobot Admin</Link>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/admin/users" className="text-gray-700 hover:text-gray-900">Users</Link>
            <Link href="/admin/items" className="text-gray-700 hover:text-gray-900">Items</Link>
            <form action={async () => { "use server"; await signOut({ redirectTo: "/" }); }}>
              <button type="submit" className="text-gray-500 hover:text-gray-700">Sign out</button>
            </form>
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
```

- [ ] **Step 2: Create the admin landing page**

```tsx
// app/admin/page.tsx
import Link from "next/link";

export default function AdminHome() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Admin</h1>
      <ul className="list-disc pl-6 text-gray-700">
        <li><Link href="/admin/users" className="text-blue-600 hover:underline">Users & redemption</Link></li>
        <li><Link href="/admin/items" className="text-blue-600 hover:underline">Items catalog</Link></li>
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Manual smoke**

```bash
pnpm dev &
sleep 6
# Without auth, /admin should 302 to sign-in.
curl -sI http://localhost:3000/admin | head -1
kill %1 2>/dev/null
```

Expected: a 3xx redirect status.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(admin): /admin layout gated by Auth.js session"
```

---

# Phase 14 — Admin Items Page

## Task 35: Items list & server actions

**Files:**
- Create: `app/admin/items/page.tsx`, `app/admin/items/actions.ts`

- [ ] **Step 1: Create the actions**

```ts
// app/admin/items/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { items } from "@/lib/db/schema";
import { auth } from "@/lib/auth";

async function requireAdmin() {
  const s = await auth();
  if (!s) throw new Error("unauthorized");
  return s;
}

function intField(form: FormData, key: string): number {
  const raw = form.get(key);
  if (typeof raw !== "string") throw new Error(`${key} required`);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
  return n;
}

function textField(form: FormData, key: string, opts: { required?: boolean } = {}): string | null {
  const raw = form.get(key);
  if (typeof raw !== "string" || raw.trim() === "") {
    if (opts.required) throw new Error(`${key} required`);
    return null;
  }
  return raw.trim();
}

export async function createItem(form: FormData) {
  await requireAdmin();
  const name = textField(form, "name", { required: true })!;
  const description = textField(form, "description");
  const imageUrl = textField(form, "image_url");
  const priceTacos = intField(form, "price_tacos");
  await db.insert(items).values({ name, description, imageUrl, priceTacos });
  revalidatePath("/admin/items");
  revalidatePath("/shop");
}

export async function updateItem(id: string, form: FormData) {
  await requireAdmin();
  const name = textField(form, "name", { required: true })!;
  const description = textField(form, "description");
  const imageUrl = textField(form, "image_url");
  const priceTacos = intField(form, "price_tacos");
  await db.update(items)
    .set({ name, description, imageUrl, priceTacos, updatedAt: sql`now()` })
    .where(eq(items.id, id));
  revalidatePath("/admin/items");
  revalidatePath("/shop");
}

export async function toggleItemActive(id: string, isActive: boolean) {
  await requireAdmin();
  await db.update(items)
    .set({ isActive, updatedAt: sql`now()` })
    .where(eq(items.id, id));
  revalidatePath("/admin/items");
  revalidatePath("/shop");
}
```

- [ ] **Step 2: Create the page**

```tsx
// app/admin/items/page.tsx
import { db } from "@/lib/db/client";
import { items } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { createItem, toggleItemActive, updateItem } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ItemsPage() {
  const all = await db.select().from(items).orderBy(desc(items.isActive), desc(items.updatedAt));

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-4 text-2xl font-bold">Items catalog</h1>
        <form action={createItem} className="grid gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-2">
          <input name="name" placeholder="Name" required className="rounded border border-gray-300 px-3 py-2" />
          <input name="price_tacos" type="number" min={1} placeholder="Price (tacos)" required className="rounded border border-gray-300 px-3 py-2" />
          <input name="image_url" placeholder="Image URL (optional)" className="rounded border border-gray-300 px-3 py-2 sm:col-span-2" />
          <textarea name="description" placeholder="Description (optional)" rows={2} className="rounded border border-gray-300 px-3 py-2 sm:col-span-2" />
          <button type="submit" className="rounded bg-amber-500 px-4 py-2 text-white hover:bg-amber-600 sm:col-span-2">
            Add item
          </button>
        </form>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">All items</h2>
        <ul className="space-y-3">
          {all.map((it) => (
            <li key={it.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <form action={async (form) => { "use server"; await updateItem(it.id, form); }} className="grid gap-3 sm:grid-cols-2">
                <input name="name" defaultValue={it.name} required className="rounded border border-gray-300 px-3 py-2" />
                <input name="price_tacos" type="number" min={1} defaultValue={it.priceTacos} required className="rounded border border-gray-300 px-3 py-2" />
                <input name="image_url" defaultValue={it.imageUrl ?? ""} className="rounded border border-gray-300 px-3 py-2 sm:col-span-2" />
                <textarea name="description" defaultValue={it.description ?? ""} rows={2} className="rounded border border-gray-300 px-3 py-2 sm:col-span-2" />
                <div className="flex items-center justify-between sm:col-span-2">
                  <span className={`text-sm ${it.isActive ? "text-emerald-700" : "text-gray-500"}`}>
                    {it.isActive ? "Active" : "Inactive"}
                  </span>
                  <div className="flex gap-2">
                    <button type="submit" className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100">
                      Save
                    </button>
                  </div>
                </div>
              </form>
              <form
                action={async () => { "use server"; await toggleItemActive(it.id, !it.isActive); }}
                className="mt-2"
              >
                <button type="submit" className="text-sm text-gray-600 underline hover:text-gray-900">
                  {it.isActive ? "Deactivate" : "Reactivate"}
                </button>
              </form>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(admin/items): list + create + edit + soft-delete with server actions"
```

---

# Phase 15 — Admin Users + Redemption

## Task 36: Redemption execution function

**Files:**
- Create: `lib/admin/redeem.ts`, `tests/integration/redemption.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/redemption.test.ts
import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, withCleanDb } from "./helpers/db";
import { upsertUser } from "@/lib/db/queries";
import { redeem } from "@/lib/admin/redeem";
import { items, transactions, users } from "@/lib/db/schema";

test("redeem deducts balance and writes transaction", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_E", name: "E", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_HR", name: "HR", dailyAllowance: 5 });
    await db.update(users).set({ receivedTotal: 10, balance: 10 }).where(eq(users.id, "U_E"));

    const [it] = await db.insert(items).values({ name: "Hoodie", priceTacos: 5 }).returning();

    const r = await redeem(db, {
      employeeId: "U_E",
      itemId: it.id,
      amount: 5,
      adminId: "U_HR",
      reason: "size M",
    });
    expect(r.kind).toBe("ok");

    const [e] = await db.select().from(users).where(eq(users.id, "U_E"));
    expect(e.balance).toBe(5);
    expect(e.receivedTotal).toBe(10); // unchanged

    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe("redeem");
    expect(txns[0].adminUserId).toBe("U_HR");
    expect(txns[0].itemId).toBe(it.id);
  });
});

test("redeem refuses to overdraw", async () => {
  await withCleanDb(async (db) => {
    await upsertUser(db, { id: "U_E", name: "E", dailyAllowance: 5 });
    await upsertUser(db, { id: "U_HR", name: "HR", dailyAllowance: 5 });
    await db.update(users).set({ receivedTotal: 3, balance: 3 }).where(eq(users.id, "U_E"));
    const [it] = await db.insert(items).values({ name: "X", priceTacos: 5 }).returning();

    const r = await redeem(db, {
      employeeId: "U_E", itemId: it.id, amount: 5, adminId: "U_HR", reason: null,
    });
    expect(r.kind).toBe("insufficient");
    const [e] = await db.select().from(users).where(eq(users.id, "U_E"));
    expect(e.balance).toBe(3);
    const txns = await db.select().from(transactions);
    expect(txns).toHaveLength(0);
  });
});

afterAll(async () => closePool());
```

- [ ] **Step 2: Run; expect failure**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/redemption.test.ts
```

Expected: FAIL — `redeem` not exported.

- [ ] **Step 3: Implement**

```ts
// lib/admin/redeem.ts
import { and, eq, gte, sql } from "drizzle-orm";
import type { DB } from "@/lib/db/client";
import { transactions, users } from "@/lib/db/schema";

export type RedeemInput = {
  employeeId: string;
  itemId: string;
  amount: number;
  adminId: string;
  reason: string | null;
};

export type RedeemResult = { kind: "ok" } | { kind: "insufficient" };

export async function redeem(db: DB, input: RedeemInput): Promise<RedeemResult> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ balance: sql`${users.balance} - ${input.amount}`, updatedAt: sql`now()` })
      .where(and(eq(users.id, input.employeeId), gte(users.balance, input.amount)))
      .returning({ id: users.id });

    if (updated.length === 0) return { kind: "insufficient" } as const;

    await tx.insert(transactions).values({
      type: "redeem",
      toUserId: input.employeeId,
      adminUserId: input.adminId,
      itemId: input.itemId,
      amount: input.amount,
      reason: input.reason,
    });
    return { kind: "ok" } as const;
  });
}
```

- [ ] **Step 4: Run**

```bash
POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot pnpm test tests/integration/redemption.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(admin): redeem function — atomic balance decrement + transaction insert"
```

---

## Task 37: Users page UI + redemption server action

**Files:**
- Create: `app/admin/users/page.tsx`, `app/admin/users/actions.ts`

- [ ] **Step 1: Create actions**

```ts
// app/admin/users/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { auth } from "@/lib/auth";
import { redeem } from "@/lib/admin/redeem";

async function requireAdminId(): Promise<string> {
  const s = await auth();
  const slackId = (s as { slackUserId?: string } | null)?.slackUserId;
  if (!slackId) throw new Error("unauthorized");
  return slackId;
}

export async function deductTacos(formData: FormData) {
  const adminId = await requireAdminId();
  const employeeId = String(formData.get("employee_id") ?? "");
  const itemId = String(formData.get("item_id") ?? "");
  const amountRaw = String(formData.get("amount") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || null;

  if (!employeeId || !itemId) throw new Error("missing fields");
  const amount = Number.parseInt(amountRaw, 10);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be positive");

  const result = await redeem(db, { employeeId, itemId, amount, adminId, reason });
  if (result.kind === "insufficient") {
    throw new Error("Employee has insufficient balance for that amount");
  }
  revalidatePath("/admin/users");
}
```

- [ ] **Step 2: Create the users page**

```tsx
// app/admin/users/page.tsx
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { items, users } from "@/lib/db/schema";
import { deductTacos } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const [allUsers, activeItems] = await Promise.all([
    db.select().from(users).where(eq(users.isActive, true)).orderBy(desc(users.balance), asc(users.name)),
    db.select({ id: items.id, name: items.name, priceTacos: items.priceTacos })
      .from(items).where(eq(items.isActive, true)).orderBy(asc(items.priceTacos)),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Users & redemption</h1>
      <table className="w-full divide-y divide-gray-200 rounded-lg bg-white">
        <thead className="text-left text-sm text-gray-600">
          <tr>
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Received</th>
            <th className="px-4 py-3">Balance</th>
            <th className="px-4 py-3">Today left</th>
            <th className="px-4 py-3">Redeem</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 text-sm">
          {allUsers.map((u) => (
            <tr key={u.id}>
              <td className="px-4 py-3 font-medium">{u.name}</td>
              <td className="px-4 py-3">{u.receivedTotal}</td>
              <td className="px-4 py-3 font-semibold">{u.balance}</td>
              <td className="px-4 py-3 text-gray-500">{u.dailyRemaining}</td>
              <td className="px-4 py-3">
                <form action={deductTacos} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="employee_id" value={u.id} />
                  <select name="item_id" required className="rounded border border-gray-300 px-2 py-1">
                    <option value="" disabled>Pick item</option>
                    {activeItems.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name} ({it.priceTacos} 🌮)
                      </option>
                    ))}
                  </select>
                  <input
                    name="amount"
                    type="number"
                    min={1}
                    max={u.balance}
                    placeholder="amount"
                    required
                    className="w-24 rounded border border-gray-300 px-2 py-1"
                  />
                  <input
                    name="reason"
                    placeholder="note (optional)"
                    className="flex-1 rounded border border-gray-300 px-2 py-1"
                  />
                  <button type="submit" className="rounded bg-amber-500 px-3 py-1 text-white hover:bg-amber-600">
                    Deduct
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(admin/users): table + per-row deduct form using redeem action"
```

---

# Phase 16 — CI

## Task 38: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: tacobot
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      POSTGRES_URL: postgres://postgres:postgres@localhost:5432/tacobot
      SLACK_BOT_TOKEN: xoxb-test
      SLACK_SIGNING_SECRET: test
      AUTH_SECRET: test
      AUTH_URL: http://localhost:3000
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:migrate
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "ci: GitHub Actions runs migrate + typecheck + lint + test + build"
```

---

# Phase 17 — Documentation

## Task 39: README rewrite

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

```markdown
# Tacobot 🌮

Internal Slack recognition program for the `wlt-and-shaman` workspace. Inspired by [HeyTaco](https://www.heytaco.com/).

Give 🌮 reactions to teammates in `#taqueria`. Every employee has a daily allowance (default 5). Tacos accumulate as a `balance` that can be redeemed in the [shop](#) — HR-mediated.

## Stack

Next.js 15 + TypeScript + Tailwind on Vercel Pro · Bolt for JS (Slack Events API) · Vercel Postgres + Drizzle ORM · Auth.js v5 + Slack OIDC for the admin pages.

## Prerequisites

- Vercel Pro (60s function timeout, unlimited cron jobs).
- Slack workspace admin to create the app.
- Vercel Postgres / Neon database attached to the project.

## One-time setup

### 1. Create the Slack app

See [docs/slack-setup.md](docs/slack-setup.md) for the full checklist (scopes, event subscriptions, OAuth redirect, OIDC scopes).

### 2. Configure environment variables

Copy `.env.example` to `.env.local` (for dev) or set them in Vercel project settings.

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-…` from app install |
| `SLACK_SIGNING_SECRET` | App's signing secret |
| `SLACK_BOT_USER_ID` | Optional; cached from `auth.test` if absent |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | For Sign in with Slack (admin) |
| `TACO_CHANNELS` | Comma-separated channel IDs where typed/reaction gives count |
| `TACO_DAILY_ALLOWANCE` | Defaults to 5 |
| `ADMIN_SLACK_IDS` | Comma-separated Slack user IDs allowed into `/admin` |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_URL` | Auto-set on Vercel via `VERCEL_URL` |
| `POSTGRES_URL` | Provided by the Vercel Postgres integration |
| `NEXT_PUBLIC_SHOP_URL` | Public URL of `/shop` |
| `CRON_SECRET` | Auto-injected by Vercel for cron requests |

### 3. Migrate the database

```bash
pnpm db:migrate
```

(Vercel runs this automatically as part of `pnpm build`.)

### 4. Bootstrap user list

After deployment, run once to import existing workspace members:

```bash
pnpm sync-users
```

Subsequent joiners are picked up by the `team_join` event automatically.

### 5. Invite the bot

In Slack, run `/invite @tacobot` in `#taqueria-beta` (or whichever channel(s) you set in `TACO_CHANNELS`).

## Local development

1. Spin up local Postgres or use a Neon dev branch:
   ```bash
   docker run -d --name tacobot-pg -e POSTGRES_PASSWORD=test \
     -e POSTGRES_DB=tacobot -p 55432:5432 postgres:16
   echo 'POSTGRES_URL=postgres://postgres:test@localhost:55432/tacobot' >> .env.local
   ```
2. Migrate: `pnpm db:migrate`
3. Start dev server: `pnpm dev`
4. (For Slack events) tunnel localhost: `ngrok http 3000` → update Slack app's Event Subscription URL.

## Operations

### Add an admin

Update `ADMIN_SLACK_IDS` in Vercel env vars (comma-separated). Redeploy.

### Change channel allowlist

Update `TACO_CHANNELS`. Redeploy. (No data migration needed — past transactions reference the channel they were sent in.)

### Change daily allowance

Update `TACO_DAILY_ALLOWANCE`. The next daily reset (00:00 UTC) refills everyone to the new value.

### Rotate Slack signing secret

Regenerate in Slack app dashboard → update Vercel env → redeploy. No DB changes.

### Inspect data

`pnpm db:studio` opens Drizzle Studio against the configured database.

## Audit queries

```sql
-- All redemptions in a quarter
SELECT u.name AS employee, i.name AS item, t.amount, t.reason, t.created_at,
       a.name AS admin
FROM transactions t
JOIN users u ON u.id = t.to_user_id
JOIN items i ON i.id = t.item_id
LEFT JOIN users a ON a.id = t.admin_user_id
WHERE t.type = 'redeem'
  AND t.created_at >= '2026-04-01' AND t.created_at < '2026-07-01'
ORDER BY t.created_at DESC;

-- Top givers this month
SELECT u.name, SUM(t.amount) AS given
FROM transactions t
JOIN users u ON u.id = t.from_user_id
WHERE t.type = 'give' AND t.created_at >= date_trunc('month', now())
GROUP BY u.name ORDER BY given DESC LIMIT 10;

-- Top receivers this month
SELECT u.name, SUM(t.amount) AS received
FROM transactions t
JOIN users u ON u.id = t.to_user_id
WHERE t.type = 'give' AND t.created_at >= date_trunc('month', now())
GROUP BY u.name ORDER BY received DESC LIMIT 10;

-- Permalink for a give
SELECT 'https://wlt-and-shaman.slack.com/archives/' || slack_channel_id ||
       '/p' || replace(slack_message_ts, '.', '')
FROM transactions WHERE id = '<txn-id>';
```

## Smoke-test checklist

After every deploy, walk through this in `#taqueria-beta`:

- [ ] Bot is online and a member of the channel.
- [ ] Type `<@teammate> :taco:`. Recipient's `received_total` and `balance` increment, your `daily_remaining` decrements, your message gets a 🌮 reaction.
- [ ] React to a teammate's message with 🌮. Their balance increments.
- [ ] DM `@tacobot score` — replies with top 5 by lifetime received.
- [ ] DM `@tacobot balance` — replies with your current balance + shop URL.
- [ ] DM `@tacobot left` — replies with your remaining daily allowance.
- [ ] DM `@tacobot help` — replies with command list.
- [ ] Try giving yourself a taco — silently no-ops.
- [ ] Try giving more tacos than you have — gets an ephemeral rejection.
- [ ] `/shop` loads and shows current items.
- [ ] Sign in to `/admin/items` (with an admin Slack ID) — add an item, confirm it appears on `/shop`.
- [ ] Sign in to `/admin/users` — deduct tacos from a test user — balance drops, transaction recorded.
- [ ] Sign-in attempt as a non-admin — rejected.
- [ ] Next morning: confirm `daily_remaining` reset to allowance.

## License

Internal use, not published.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for the new architecture"
```

---

# Phase 18 — Beta Deploy

These steps are operational, not code; the engineer follows them after the prior phases land.

## Task 40: Vercel project + Postgres

- [ ] **Step 1:** Create a new Vercel project, link it to this repo's `master` branch.
- [ ] **Step 2:** In the Vercel dashboard → Storage tab → Create → **Postgres**. Attach to the project. This auto-injects `POSTGRES_URL` and related vars.
- [ ] **Step 3:** Confirm the cron job from `vercel.json` appears under Settings → Cron Jobs.

## Task 41: Set environment variables

- [ ] **Step 1:** In Vercel → Settings → Environment Variables, set: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_USER_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `ADMIN_SLACK_IDS`, `TACO_CHANNELS` (set to `#taqueria-beta`'s ID), `TACO_DAILY_ALLOWANCE=5`, `AUTH_SECRET=$(openssl rand -base64 32)`, `NEXT_PUBLIC_SHOP_URL=https://<deploy-host>/shop`.
- [ ] **Step 2:** Verify `CRON_SECRET` and `POSTGRES_URL` are auto-set.

## Task 42: First deploy

- [ ] **Step 1:** Push to `master`. Vercel deploys automatically. Confirm the deployment succeeded in the dashboard (build runs `pnpm db:migrate && next build`).
- [ ] **Step 2:** Hit the production URL — confirm `/` and `/shop` load.

## Task 43: Wire Slack events to production

- [ ] **Step 1:** In the Slack app dashboard → Event Subscriptions → Request URL: set to `https://<deploy-host>/api/slack/events`. Slack issues a `url_verification` challenge; our handler echoes it. Confirm green check.
- [ ] **Step 2:** OAuth redirect URL: set to `https://<deploy-host>/api/auth/callback/slack`.
- [ ] **Step 3:** Reinstall the app to the workspace if Slack prompts (scope changes can require it).

## Task 44: Bootstrap users

- [ ] **Step 1:** Locally, with the production `POSTGRES_URL` in `.env.local`, run:
  ```bash
  pnpm sync-users
  ```
- [ ] **Step 2:** Confirm the row count printed roughly matches the workspace's active member count.

## Task 45: Smoke test in #taqueria-beta

- [ ] **Step 1:** `/invite @tacobot` in `#taqueria-beta`.
- [ ] **Step 2:** Walk the smoke-test checklist from `README.md`. Confirm every item.
- [ ] **Step 3:** Wait until the next 00:00 UTC and confirm allowances reset.

## Task 46: Cutover plan (post-beta)

- [ ] **Step 1:** When ready, uninstall HeyTaco from the workspace.
- [ ] **Step 2:** Update `TACO_CHANNELS` in Vercel env to the production `#taqueria` channel ID. Redeploy.
- [ ] **Step 3:** Invite the bot to `#taqueria`.
- [ ] **Step 4:** Announce to the team in `#general`.

---

# Plan Deviations (annotated post-execution)

The plan was written from spec, before any code was run. Seven places needed deviations during execution. The full per-deviation rationale lives in [`2026-05-02-tacobot-rebuild-execution.md`](2026-05-02-tacobot-rebuild-execution.md); this section is a quick map from task to fix.

| Plan task | What the plan said | What was actually shipped | Commit |
|---|---|---|---|
| Task 1 step 5 | `git add -A` then commit | Explicit `git add <path1> <path2> …` to avoid sweeping in untracked env files | `8308592` |
| Task 2 | No `.npmrc` step | Added `.npmrc` with `store-dir=/home/node/.pnpm-store` (pnpm copyfile race in dev container otherwise) | `a7bde07` |
| Task 2 (gitignore) | Original `.gitignore` from Task 1 | Added `tsconfig.tsbuildinfo` to ignore list | `bd14ed7` |
| Task 3 (eslint config) | `import nextPlugin from "eslint-config-next"; export default [...nextPlugin, …]` + `lint: next lint` | `FlatCompat` from `@eslint/eslintrc` to bridge legacy config; `lint` script switched to `eslint .` (Next 15 deprecates `next lint`) | `37724f9` |
| Task 8 | Docker `postgres:16` container + `pg` driver for tests | `@electric-sql/pglite` (in-process WASM Postgres) — dev container has no Docker | `f17db8f` |
| Task 12 | `new App({ token, receiver })` | Added `processBeforeResponse: true` (FaaS-correct on Vercel — verified via context7 in Task 11) | `f6a33a5` |
| Task 33 (Auth.js) | `signIn({ profile })` reads `profile["https://slack.com/user_id"] ?? profile.sub` inline | Extracted to a `pickSlackUserId(profile)` helper, used in both `signIn` and `jwt` callbacks | `8630b49` |
| Task 38 (CI) | Postgres service container + `pnpm db:migrate` + `pnpm build` | No service container (pglite is in-process); skip `pnpm build` (`next build` needs real Slack creds + DB which CI doesn't have); rely on `pnpm typecheck` for compile validation. Vercel runs the real build at deploy time | `7465e94` |

The pure-logic tasks (parser, give-validate, give-decide, executeGive, redeem, all integration tests) shipped exactly as specified. The deviations all clustered around (a) the dev environment's quirks and (b) version drift in `eslint-config-next` / `next lint` between the plan's assumptions and what's actually current.

---

# Self-Review

**Spec coverage check:**

| Spec section | Implemented in |
|---|---|
| §3 Architecture (single Next.js app on Vercel) | Phases 1–2 |
| §4.1 users table | Task 5 |
| §4.2 items table | Task 6 |
| §4.3 transactions table | Task 7 |
| §4.5 Defense-in-depth (CHECK constraints) | Task 23 |
| §5.1 Events subscribed | Tasks 24, 25, 26, 28 |
| §5.2 Channel allowlist | Tasks 16, 25 |
| §5.3 Give pipeline — typed | Tasks 14–24 |
| §5.4 Give pipeline — reactions | Task 25 |
| §5.5 Commands (incl. French synonyms) | Tasks 26, 27 |
| §5.6 Ack-within-3s | Tasks 11–13 |
| §5.7 Bot user ID resolution | Task 24 (`botUserId.ts`) |
| §5.8 User sync | Tasks 28, 29 |
| §6.1 Public shop | Task 31 |
| §6.2 Admin pages | Tasks 34–37 |
| §6.3 Auth.js + Slack OIDC | Tasks 32–33 |
| §7.1 Daily reset cron | Task 30 |
| §7.2 Audit log + sample SQL | Schema in Task 7; queries in README (Task 39) |
| §7.3 Error handling | Throughout (signature failure, idempotency, etc.) |
| §7.5 Migrations | Task 8, plus build-step in Task 2 |
| §8 Testing & CI | Tasks 14–23, 25, 26, 30, 36 (tests); Task 38 (CI) |
| §9 Local dev | Task 39 (README) |
| §10 Documentation | Tasks 10, 39 |
| §12 Phased build plan | This document, by construction |

**Gaps fixed during self-review:** none found on first pass.

**Ambiguities resolved:**
- The `slack_event_id` for typed gives uses `event.event_ts` rather than the envelope `body.event_id` because Bolt's `event` argument exposes `event_ts` reliably. If Task 11's research finds a clean way to get `body.event_id` in handlers, prefer it (note in Task 24).
- The `dispatch` function exposed via `__test` for testing is the simplest seam without rebuilding the Bolt event lifecycle in tests; this is the correct seam.

**Type consistency check:** `executeGive`, `redeem`, `validate`, `decide`, `processReaction` all consistently use `DB` from `@/lib/db/client` and operate on `transactions`/`users`/`items` from `@/lib/db/schema`. Plan transaction shapes (`PlannedTransaction`, `RedeemInput`) are defined once and referenced from both implementation and tests.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-02-tacobot-rebuild.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a plan this size — keeps each task in a clean context window and catches drift early.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
