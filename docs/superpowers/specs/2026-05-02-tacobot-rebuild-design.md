# Tacobot Rebuild — Design Spec

**Date:** 2026-05-02
**Status:** Draft, pending user review
**Author:** Brainstormed with Claude (Opus 4.7)

## 1. Context & Goals

The current repo is a 7-year-old fork of an open-source HeyTaco-clone Slack bot ("Tacobot"). It uses Botkit + Slack RTM + a single-file JSON "database" + Node 10. The transport stack (RTM + classic-app `bot` scope) is being deprecated by Slack, Botkit (the original Howdy.ai project) is unmaintained, and Node 10 is years out of LTS. The owner ("we", a 50-person company with HR, Slack workspace `wlt-and-shaman`) wants to **start supporting** this bot, not as a port but as the foundation for a real internal recognition program.

The owner currently pays for HeyTaco. The rebuild is intended to replicate HeyTaco's feature set — including its **Taco Shop** (a public catalog where employees redeem accumulated tacos for company perks, mediated by HR) — and run it self-hosted on Vercel.

### Goals

1. Modern, maintainable stack: TypeScript, Bolt for JS, Next.js 15, Postgres.
2. Single-tenant deployment to Vercel Pro (single workspace, single deploy).
3. Feature parity with HeyTaco for the day-one needs: give tacos, leaderboard, balance, daily allowance, daily reset, **shop catalog**, **HR-mediated redemption**.
4. Defense-in-depth at the database level for the two abuse rules that matter ("no self-give", "no more than N gives per day"), commensurate with a low-threat internal-bot environment.
5. A codebase the owner is comfortable iterating on long-term — clear boundaries, idiomatic Next.js, sensible test coverage, real CI.
6. Beta-coexistence with HeyTaco during cutover (bot listens to a separate channel until HeyTaco is uninstalled).

### Non-Goals (v1)

- Multi-workspace / distributable Slack app (no OAuth install flow, no per-workspace token storage).
- In-bot redemption flow (DM-the-bot-to-buy). Redemption is HR-mediated outside the system.
- Audit-log UI in the admin pages. Audit data lives in the `transactions` table; queryable via SQL.
- Image hosting / asset uploads. Item images are external URLs pasted by HR.
- Stock / inventory tracking on items. Catalog CRUD only.
- Per-item redemption history surfaced in admin UI.
- Mutual-give / collusion detection. Out of scope per the "no rogues" threat model.
- E2E tests through real Slack or real Auth.js OAuth flows.
- Notification / alerting infrastructure (Sentry, Datadog, etc.).
- Custom design system or branding beyond Tailwind defaults.
- Trigger-based DB enforcement of the daily-give limit. The counter-column + CHECK constraint approach is sufficient for the threat model.

## 2. Stack & Hosting

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node 20.x (LTS) | Bolt requires Node-only crypto; consistency simplifies mental model |
| Language | TypeScript 5.x, `strict: true` | Single dialect across bot + web + scripts |
| Web framework | Next.js 15 (App Router) | Native Vercel target; covers API routes + RSC pages + server actions in one |
| Slack SDK | `@slack/bolt` v4.x | Official, current, lazy-listener pattern handles Slack's 3s ACK |
| Database | Vercel Postgres (Neon-backed) | Native Vercel integration, free tier covers this scale |
| ORM | Drizzle ORM + Drizzle Kit | TypeScript-first, edge-compatible, no runtime engine like Prisma |
| Auth | Auth.js v5 (NextAuth successor) | Built-in Slack provider, JWT sessions, no sessions table needed |
| Cron | Vercel Cron Jobs | Pro tier supports unlimited cron; native to platform |
| Styling | Tailwind CSS | Default Next.js choice; no custom design system needed |
| Package manager | pnpm | Fast, deterministic, idiomatic for new Next.js projects |
| Test runner | Vitest | Native TS, fast, idiomatic for Next.js |
| Lint/format | ESLint (Next.js config) + Prettier (defaults) | No bespoke rules |
| CI | GitHub Actions | Standard; Postgres service container for integration tests |

**Hosting target:** Vercel Pro project, single deployment. `main` branch auto-deploys to production; PRs get preview deployments. Database is a Vercel Postgres instance attached to the project (production); a separate Neon dev branch is used for local development.

## 3. Architecture

### 3.1 Repo layout

```
tacobot/
├── app/                                  # Next.js App Router
│   ├── api/
│   │   ├── slack/events/route.ts         # Bolt receiver, Events API
│   │   ├── auth/[...nextauth]/route.ts   # Auth.js handler
│   │   └── cron/reset-allowance/route.ts # Vercel Cron target
│   ├── shop/page.tsx                     # public catalog (RSC)
│   ├── admin/
│   │   ├── layout.tsx                    # auth gate
│   │   ├── users/page.tsx                # search + deduct from balance
│   │   └── items/page.tsx                # CRUD on catalog
│   ├── layout.tsx
│   └── page.tsx                          # landing / link-to-shop
├── lib/
│   ├── slack/
│   │   ├── bolt.ts                       # Bolt app instantiation
│   │   ├── receiver.ts                   # custom Bolt receiver for App Router
│   │   ├── handlers.ts                   # registers all Bolt event handlers
│   │   ├── give.ts                       # give pipeline (validate→decide→execute)
│   │   ├── commands.ts                   # score / balance / left / help / shop
│   │   ├── parser.ts                     # countTacos, findUserIds
│   │   └── format.ts                     # message formatting helpers
│   ├── db/
│   │   ├── schema.ts                     # Drizzle schema definitions
│   │   ├── client.ts                     # @vercel/postgres + Drizzle client
│   │   └── queries.ts                    # typed query helpers
│   ├── auth.ts                           # Auth.js config + admin allowlist
│   └── config.ts                         # env-var parsing, typed config
├── scripts/
│   └── sync-users.ts                     # one-shot bootstrap from users.list
├── drizzle/                              # generated migrations (committed)
├── tests/
│   ├── unit/
│   └── integration/
├── public/                               # static assets
├── .env.example
├── vercel.json                           # cron schedule
├── drizzle.config.ts
├── next.config.ts
├── tsconfig.json
├── package.json
└── README.md
```

### 3.2 Components & responsibilities

- **`app/api/slack/events`** — single endpoint for all Slack events. Verifies signing secret on raw body, hands to Bolt, ACKs in <1s.
- **`lib/slack/bolt.ts`** — instantiates the Bolt app with the custom receiver. Registers all handlers from `handlers.ts`.
- **`lib/slack/give.ts`** — the heart of the bot. Three pure phases: `validate(intent, config) → ValidationResult`, `decide(intent, giverState) → Plan`, `execute(plan, db) → Result`. Pure phases are unit-testable without DB or Slack.
- **`lib/db/schema.ts`** — Drizzle table definitions. Single source of truth for the schema.
- **`lib/auth.ts`** — Auth.js config with Slack OIDC provider; `signIn` callback enforces the admin allowlist.
- **`app/admin/*`** — server-rendered pages with server actions for mutations. Auth gated by `app/admin/layout.tsx` reading the JWT.
- **`app/shop/page.tsx`** — server-rendered, public, reads `items` table where `is_active = true`.
- **`app/api/cron/reset-allowance`** — Vercel Cron target. Verifies `Authorization: Bearer ${CRON_SECRET}`; runs the reset SQL.
- **`scripts/sync-users.ts`** — one-shot operational script to bulk-import existing workspace members. Run after first deploy.

### 3.3 Existing-fork repo strategy

All current `.js` files (`index.js`, `bot.js`, `taco.js`, `db.js`, `slack.js`, `parser.js`, `utils.js`, `slack.test.js`, `taco.test.js`) are **deleted** in the rewrite. Git history preserves them; keeping parallel old/new code rots fast. `package.json`, `package-lock.json`, `yarn.lock`, `README.md`, `CLAUDE.md`, `.gitignore` are all replaced. The `db.json` in `.gitignore` is no longer relevant but the entry is harmless.

## 4. Data Model

Three tables. Auth.js v5 uses JWT sessions, so no sessions table is required.

### 4.1 `users`

```sql
CREATE TABLE users (
  id              text PRIMARY KEY,                    -- Slack user ID, e.g. "U0123ABC"
  name            text NOT NULL,                       -- display name
  daily_remaining integer NOT NULL,                    -- counter, resets daily
  received_total  integer NOT NULL DEFAULT 0,          -- lifetime received
  balance         integer NOT NULL DEFAULT 0,          -- spendable
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (daily_remaining >= 0),
  CHECK (received_total >= 0),
  CHECK (balance >= 0),
  CHECK (balance <= received_total)
);
```

`name` resolution from Slack: prefer `profile.display_name` if non-empty, else `profile.real_name`, else `user.name`. Refreshed on every `user_change` event.

`received_total` and `balance` are **denormalized counters** kept in sync transactionally with `transactions` rows. Could be derived, but querying is trivial this way and the invariant (`balance <= received_total`) is checked by the DB.

### 4.2 `items`

```sql
CREATE TABLE items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text,
  image_url    text,
  price_tacos  integer NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (price_tacos > 0)
);

CREATE UNIQUE INDEX items_active_name_unique
  ON items (lower(name)) WHERE is_active;            -- no duplicate live items
```

Soft delete only — past redemptions in `transactions` continue to FK-resolve.

### 4.3 `transactions` (single ledger for gives + redemptions)

```sql
CREATE TABLE transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type              text NOT NULL,                                    -- 'give' | 'redeem'
  to_user_id        text NOT NULL REFERENCES users(id),               -- recipient or redeemer
  from_user_id      text REFERENCES users(id),                        -- give only
  admin_user_id     text REFERENCES users(id),                        -- redeem only
  item_id           uuid REFERENCES items(id),                        -- redeem only
  amount            integer NOT NULL,
  reason            text,                                             -- message text or HR note
  slack_event_id    text UNIQUE,                                      -- idempotency key
  slack_channel_id  text,
  slack_message_ts  text,                                             -- for permalink reconstruction
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (type IN ('give','redeem')),
  CHECK (amount > 0),
  CHECK (
    (type = 'give'
       AND from_user_id IS NOT NULL
       AND admin_user_id IS NULL
       AND item_id IS NULL
       AND from_user_id <> to_user_id)
    OR
    (type = 'redeem'
       AND from_user_id IS NULL
       AND admin_user_id IS NOT NULL
       AND item_id IS NOT NULL)
  )
);

CREATE INDEX transactions_to_created      ON transactions (to_user_id, created_at DESC);
CREATE INDEX transactions_from_created    ON transactions (from_user_id, created_at DESC);
CREATE INDEX transactions_type_created    ON transactions (type, created_at DESC);
CREATE INDEX transactions_admin_created   ON transactions (admin_user_id, created_at DESC);
```

The shape-and-rule CHECK enforces both the structural shape (`give` rows have `from_user_id`, `redeem` rows have `admin_user_id` + `item_id`) and the **no-self-give** rule simultaneously.

`slack_event_id UNIQUE` is the idempotency key for Slack retries. For typed `:taco:` gives the value is derived from the Slack envelope's `event_id` (Bolt exposes this as `body.event_id`). For multi-recipient typed gives, the per-recipient key is synthesized as `${envelope_event_id}-${recipient_index}` where `recipient_index` is the position in the recipient list **after sorting recipients by Slack user ID** (sorting ensures the same key is generated on a Slack retry). For reaction-based gives, the synthesized key is `react-${channel}-${ts}-${reactor}`. Postgres treats multiple NULLs as not-equal in UNIQUE constraints, so redeem rows (which have NULL `slack_event_id`) coexist freely.

### 4.4 Why one transactions table

Queries like "audit log for user Alice" or "everything HR did this quarter" become single queries instead of UNIONs. If schemas diverge later, we split.

### 4.5 Defense-in-depth summary

| Concern | Enforcement |
|---|---|
| No self-give | CHECK constraint on `transactions` (DB-level) |
| Daily limit | `users.daily_remaining` counter + CHECK (>= 0) + atomic UPDATE-with-WHERE in app code |
| No double-give on Slack retries | `slack_event_id UNIQUE` + Postgres transaction |
| Concurrent gives racing past the cap | Atomic single-row UPDATE serializes them |
| Negative tacos / overdraft on redeem | CHECK constraints on `users.balance >= 0`, `transactions.amount > 0` |
| Zero-price item exploit | CHECK on `items.price_tacos > 0` |
| Admin tampering | Logged in `transactions.admin_user_id` for review |

## 5. Slack Bot Behavior

### 5.1 Events subscribed

| Event | Purpose |
|---|---|
| `message.channels` | Detect typed `:taco:` in allowlisted channels |
| `message.im` | DM-based commands (score, balance, left, help, shop) |
| `app_mention` | `@tacobot`-prefixed commands in any channel where bot is invited |
| `reaction_added` | `:taco:` emoji reaction → 1-taco give |
| `team_join` | Auto-create user row when someone joins the workspace |
| `user_change` | Refresh display name / set `is_active = false` on `deleted = true` |

(No `reaction_removed`. Removing a `:taco:` reaction does not un-give.)

### 5.2 Channel allowlist

Configured via `TACO_CHANNELS` env var (comma-separated channel IDs). Channel **IDs** not names — IDs are stable across renames. Lookup: right-click channel → "View channel details" → ID at bottom; also visible in URL `/archives/C0123ABCDE`.

| Surface | Allowlist applied? |
|---|---|
| Typed `:taco:` (`message.channels`) | ✅ filter by `event.channel` |
| `:taco:` reaction (`reaction_added`) | ✅ filter by `event.item.channel` |
| `app_mention` commands | ❌ works wherever bot is invited |
| DM commands | ❌ DMs always work |
| `team_join` / `user_change` | ❌ workspace-wide |

Out-of-allowlist `:taco:` events are **silently ignored** (no ephemeral rejection). Reasoning: low spam, channel rules are communicated socially in a 50-person company.

For the beta period:
- `TACO_CHANNELS=<id of #taqueria-beta>` while HeyTaco continues running in `#taqueria`.
- Flip to `TACO_CHANNELS=<id of #taqueria>` after HeyTaco is uninstalled.

### 5.3 Give pipeline — typed messages

On `message.channels` event:

1. **Filter:** ignore if `bot_id` set, `subtype === 'message_changed'` or `'message_deleted'`, or `event.channel` not in `TACO_CHANNELS`.
2. **Parse:** `countTacos(text)` → integer count of `:taco:` substrings; `findUserIds(text)` → de-duplicated array of Slack user IDs from `<@U…>` and `<@U…|name>` mentions.
3. **Filter recipients:** drop the giver, drop the bot user, drop unknown/inactive users. (Lazy-upsert recipients: any `<@U…>` for a user not in DB triggers an upsert before validation.) **Sort the resulting list by Slack user ID** so the per-recipient `slack_event_id` is stable across Slack retries.
4. **Compute demand:** `total_demand = taco_count × |recipients|`. Each tagged user gets the full count (matches HeyTaco semantics).
5. **Validate giver:** lookup giver in DB; if missing, lazy-upsert. If giver `is_active = false`, silently skip.
6. **Quota check:** if `total_demand === 0`, no-op (no recipients or no `:taco:`). If `total_demand > giver.daily_remaining`, post ephemeral reply: "You only have N tacos left today; this would need M." No state changes.
7. **Execute (single Postgres transaction):**
   - `UPDATE users SET daily_remaining = daily_remaining - $total_demand, updated_at = now() WHERE id = $giver AND daily_remaining >= $total_demand RETURNING daily_remaining` — if 0 rows, ROLLBACK and treat as quota failure.
   - For each recipient: `UPDATE users SET received_total = received_total + $count, balance = balance + $count, updated_at = now() WHERE id = $recipient`.
   - For each (giver, recipient) pair: `INSERT INTO transactions (type, from_user_id, to_user_id, amount, reason, slack_event_id, slack_channel_id, slack_message_ts) VALUES ('give', ..., ON CONFLICT (slack_event_id) DO NOTHING)`. Per-recipient event_id is `${event.event_id}-${recipient_index}` to keep them unique while staying derivable.
   - COMMIT.
8. **Visual ack:** `reactions.add` `:taco:` to the original message. Failure of this step is logged but does not roll back.

### 5.4 Give pipeline — reactions

On `reaction_added`:

1. Skip unless `event.reaction === 'taco'`.
2. Skip unless `event.item.channel ∈ TACO_CHANNELS` and `event.item.type === 'message'`.
3. Look up message author via `conversations.history` (lookup limited to the single `ts`). If author = reactor, author = bot, or author/reactor inactive → skip.
4. Lazy-upsert reactor and author if missing.
5. Atomic give of 1 taco using the same transaction shape as 5.3 with synthesized `slack_event_id = react-${channel}-${ts}-${reactor}`.
6. On success: no visible ack (the `:taco:` reaction itself is the ack). On quota failure: ephemeral reply to the reactor in the same channel.

### 5.5 Commands

Triggered via `app_mention` or `message.im`. Match using regex on the message text. Original-bot French synonyms preserved.

| Triggers | Reply |
|---|---|
| `score`, `ranking`, `leaderboard` | Top 5 by `received_total` (lifetime; never decremented by redemption). |
| `left`, `how many`, `how much`, `combien` | "You have N tacos left to give today." |
| `balance`, `wallet` | "You have N tacos to spend." Includes shop URL. |
| `shop`, `boutique` | Just the shop URL. |
| `help`, `aide`, `commandes` | Help text covering all commands and the channel rule. |

If the caller is not in `users` (shouldn't happen if `team_join` is wired correctly, but defensively): lazy-upsert with default allowance.

### 5.6 Ack-within-3s pattern

Bolt's lazy-listener pattern: handler structure is `({ event, ack }) => { await ack(); /* async work */ }`. The route handler in `app/api/slack/events/route.ts` returns 200 to Slack as soon as Bolt's `ack()` resolves. Async work (DB writes, `chat.postEphemeral`, `reactions.add`) continues after the response is sent. Vercel functions on Pro support this via the `waitUntil` pattern (or by `await`ing in-line if work fits in the function timeout).

### 5.7 Bot user ID resolution

The bot's own Slack user ID (used to filter our own messages) is fetched at cold start via `auth.test` and cached in module scope. Optionally pinned via `SLACK_BOT_USER_ID` env var to avoid the API call on each cold start.

### 5.8 User sync

- **Bootstrap (one-shot after first deploy):** `pnpm run sync-users` runs `scripts/sync-users.ts`, which pages through `users.list` with `cursor` pagination (no 100-user cap), filters out bots and deleted users, and upserts into `users`.
- **Ongoing:** `team_join` event upserts new joiners. `user_change` event refreshes `name` and flips `is_active` based on `event.user.deleted`.
- **Lazy upsert:** any give path will upsert a missing user on demand as a safety net.

## 6. Web Application

### 6.1 Public shop page (`/shop`)

Server-rendered. No authentication. Reads `items WHERE is_active = true ORDER BY price_tacos ASC, name ASC`. Renders a list with: name, optional image, optional description, taco price. Footer text directs users to DM HR with the item name and explains how to check balance via `@tacobot balance`.

No client interactivity beyond standard browser scrolling. No "buy" button.

### 6.2 Admin pages (`/admin/*`)

Gated by `app/admin/layout.tsx` which checks the JWT. Unauthenticated → redirect to `/api/auth/signin`. Non-admin → 403 page with "Sign in with a different account" link.

**`/admin/users`**

- Table: `name`, `received_total`, `balance`, `daily_remaining`, `is_active`, last activity timestamp.
- Search box filters by name (client-side filtering, since 50 users fits comfortably).
- Per-row "Deduct" button opens a modal:
  - Amount (integer > 0)
  - Item dropdown (active items only; required)
  - Optional reason note
  - Submit calls a server action that runs (in a single Postgres transaction):
    - `UPDATE users SET balance = balance - $amount, updated_at = now() WHERE id = $user AND balance >= $amount RETURNING balance` — if 0 rows, return error to client.
    - `INSERT INTO transactions (type, to_user_id, admin_user_id, item_id, amount, reason) VALUES ('redeem', ...)`.
  - On success, page revalidates.

**`/admin/items`**

- Table of all items (active and inactive), with toggle for `is_active`.
- "Add item" button → modal form: name, description, image URL, taco price.
- Per-row "Edit" → same form.
- Server actions for create / update / soft-delete (toggle `is_active`).

No hard delete UI. Items soft-deleted by toggling `is_active = false` so historical redemptions still resolve.

### 6.3 Authentication

[Auth.js v5](https://authjs.dev/) with the built-in Slack provider. JWT session strategy. (Auth.js v5 is in late beta as of this writing but stable enough for a single-tenant admin gate; if material issues surface during implementation we fall back to a hand-rolled OIDC flow against Slack — ~50 lines, covered as a contingency in the implementation plan.)

**Flow:**

1. Visitor hits `/admin/...` → middleware (or `layout.tsx`) checks session → redirects unauthenticated to `/api/auth/signin`.
2. "Sign in with Slack" button → Slack OAuth (OpenID Connect: `openid`, `profile`, `email` user-token scopes).
3. Auth.js callback → JWT issued with Slack user ID claim.
4. `signIn` callback in `lib/auth.ts` checks `slackUserId ∈ ADMIN_SLACK_IDS` env var. Not in list → return `false`, sign-in rejected.
5. `/admin/*` layout reads JWT, allows access.

**Slack app configuration (added to existing Slack app, alongside Events API):**

- New OAuth redirect URL: `https://<deploy-host>/api/auth/callback/slack`.
- New user-token scopes: `openid`, `profile`, `email`.
- Bot scopes (existing) unchanged.

`ADMIN_SLACK_IDS=U0123ABC,U0456DEF` — comma-separated list. Adding/removing an admin = update env var + redeploy. For ~5 admins this is operationally fine; if it grows we move to a DB table.

## 7. Cron, Audit, Errors, Operations

### 7.1 Daily allowance reset

`vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/reset-allowance", "schedule": "0 0 * * *" }
  ]
}
```

Schedule is **00:00 UTC**, fixed in the file (Vercel Cron schedules don't interpolate env vars). To shift to a different timezone, edit the cron expression and redeploy. UTC is the default because the team is small enough that any single timezone choice is a compromise; UTC is the least-surprising baseline.

The handler:

1. Verifies `Authorization: Bearer ${CRON_SECRET}` (Vercel auto-injects `CRON_SECRET`).
2. Runs `UPDATE users SET daily_remaining = $TACO_DAILY_ALLOWANCE, updated_at = now() WHERE is_active = true`.
3. Logs row count and returns 200.

Idempotent — if Vercel retries, running twice is harmless.

### 7.2 Audit log

The `transactions` table is the audit log. Every give and redemption is recorded with full context. No UI in v1. README documents sample queries:

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

-- Permalink reconstruction for a give
SELECT 'https://wlt-and-shaman.slack.com/archives/' ||
        slack_channel_id || '/p' || replace(slack_message_ts, '.', '')
FROM transactions WHERE id = '<txn-id>';
```

### 7.3 Error handling

| Scenario | Behavior |
|---|---|
| Slack signing-secret mismatch | Route returns 401, no processing |
| Bolt handler throws | Caught by `app.error()`, logged, ACK already sent |
| Slack retries an already-processed event | Insert hits `slack_event_id UNIQUE` (`23505`); caught and treated as success |
| DB connection lost mid-give | Postgres transaction rolls back; counter not decremented; Slack retries; retry succeeds |
| `chat.postEphemeral` / `reactions.add` fails after the give recorded | Logged. The give is real (in DB); only the visual ack is missing. Acceptable. |
| Cron handler fails | Vercel retries; reset is idempotent |
| Auth.js: non-allowlist user signs in | `signIn` callback returns `false` → AccessDenied page |
| Admin redemption: insufficient balance | Server action returns error; UI surfaces it |

### 7.4 Logging & observability (v1)

Vercel Logs only. Structured-ish: log JSON objects with `event`, `slack_user_id`, `outcome` keys for the give/redeem paths. No Sentry, Datadog, or external log shipping.

### 7.5 Database migrations

Drizzle Kit:

- `pnpm db:generate` — generates a new SQL migration based on schema diffs.
- `pnpm db:migrate` — applies pending migrations.
- Migrations are committed to `drizzle/` in the repo.
- Vercel build step runs `pnpm db:migrate && next build` so production deploys include schema changes. (For v0 launch this is fine; later we'd separate the migrate step to avoid migrating on every preview deploy.)

### 7.6 Secrets & rotation

- All secrets in Vercel project env vars (encrypted at rest).
- `SLACK_SIGNING_SECRET` / `SLACK_BOT_TOKEN` rotation: regenerate in Slack app dashboard → update Vercel env → redeploy. No DB migration.
- `AUTH_SECRET` rotation: invalidates all admin sessions (admins re-sign-in via Slack).
- `CRON_SECRET`: managed by Vercel automatically.

## 8. Testing & CI

### 8.1 Test layers

**Pure unit tests (Vitest, no DB, no Slack):**
- `lib/slack/parser.ts` — `countTacos`, `findUserIds` — including edge cases: `<@U…|name>` form, multiple mentions, punctuation around `:taco:`, no `:taco:`, no mentions.
- `lib/slack/give.ts` `validate` and `decide` phases — given input intent + state, assert correct ValidationResult / Plan. Covers self-give filtering, channel allowlist, multi-recipient demand calc, all-or-nothing rejection, inactive-user filtering.

**Integration tests (Vitest + real Postgres):**
- Test database via `POSTGRES_URL_TEST` env var locally; GitHub Actions Postgres service container in CI.
- Each test wraps work in a transaction rolled back at teardown — fast, deterministic, no cleanup.
- Coverage:
  - Idempotency on duplicate `slack_event_id` — second insert no-ops, no double-give.
  - Concurrent gives racing past the cap — only one of two parallel batches succeeds.
  - Self-give CHECK actually fires (insert directly with same from/to → `23514`).
  - Redemption can't overdraw — atomic UPDATE returns 0 rows, transaction rolls back.
  - `received_total >= balance` invariant holds across give-then-redeem sequences.
  - Soft-delete keeps historical FK references valid.

**Manual smoke tests (documented in README, run pre-launch and during beta):**
- Bot online, joined `#taqueria-beta`.
- Typed `:taco:` to a teammate → recipient's `received_total` and `balance` increment, sender's `daily_remaining` decrements, message gets `:taco:` reaction.
- React with `:taco:` → recipient gets 1.
- `@tacobot score`, `balance`, `left`, `help` reply correctly.
- Self-give silently no-ops.
- Over-spend gets ephemeral rejection.
- `/shop` page loads and shows items.
- Sign in to `/admin/items` as admin Slack ID → add item → see on `/shop`.
- Sign in to `/admin/users` → deduct tacos from a test user → balance drops, transaction recorded.
- Sign-in attempt as non-admin Slack ID is rejected.
- Daily reset cron actually fires at 00:00 UTC (verify next morning).

### 8.2 Out of scope for v1

- E2E tests through real Slack or real Auth.js OAuth.
- UI snapshot tests.
- Load testing.
- Mutation testing.

### 8.3 CI (GitHub Actions)

Workflow runs on PRs to `main` and pushes to `main`:

1. Checkout
2. Setup Node 20, pnpm
3. `pnpm install --frozen-lockfile`
4. `pnpm lint`
5. `pnpm typecheck` (`tsc --noEmit`)
6. `pnpm test` (Vitest, with Postgres service container, runs migrations first)
7. `pnpm build` (Next.js production build — catches misconfigured routes)

Vercel deploys are independent of GitHub Actions: Vercel auto-deploys on push to `main`; preview deploys for PRs.

## 9. Local Development

### 9.1 Database

Recommended: Neon dev branch off the production database (free, isolated, web console). Set `POSTGRES_URL` in `.env.local` to the dev branch URL. Alternative: Docker Compose with stock Postgres image (also documented).

### 9.2 Slack event delivery

Slack must reach a public URL to deliver events. For local dev:

1. `ngrok http 3000` (or `cloudflared tunnel`).
2. Update the Slack app's Event Subscriptions URL to the ngrok URL with path `/api/slack/events`.
3. Don't forget to set Slack app's OAuth redirect URL to the ngrok URL too if testing admin sign-in locally.

For most development, beta deployment to a Vercel preview URL is simpler than running locally — Vercel preview deploys are free and reachable.

### 9.3 Env file

`.env.example` checked in; `.env.local` gitignored. Variables:

```bash
# Slack — bot side
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_BOT_USER_ID=U...                    # optional; cached from auth.test if absent
TACO_CHANNELS=C0123ABCDE                  # comma-separated Slack channel IDs
TACO_DAILY_ALLOWANCE=5

# Slack — Sign in with Slack (admin)
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
ADMIN_SLACK_IDS=U0123ABC,U0456DEF

# Auth.js
AUTH_SECRET=...                            # openssl rand -base64 32
AUTH_URL=https://your-deploy.vercel.app    # auto-set on Vercel via VERCEL_URL

# Database
POSTGRES_URL=...                           # Vercel Postgres / Neon

# Public-facing
NEXT_PUBLIC_SHOP_URL=https://your-deploy.vercel.app/shop
```

## 10. Documentation

`README.md` covers (in this order):

1. **What it does** — one paragraph, including the channel allowlist rule.
2. **Prerequisites** — Vercel Pro, Slack workspace admin, Postgres.
3. **Slack app setup** — concrete checklist:
   - Create app from manifest (or scratch)
   - Bot user, bot scopes (`chat:write`, `reactions:write`, `reactions:read`, `users:read`, `channels:history`, `groups:history`, `im:history`, `app_mentions:read`, `team:read`). Verified against current Slack scope catalog during implementation via context7.
   - Event subscriptions: list of events
   - Sign in with Slack: redirect URL, OIDC scopes
   - Install app to workspace; copy bot token
4. **Environment variables** — annotated `.env.example`.
5. **Local development** — Neon dev branch, ngrok, `pnpm dev`.
6. **Deploying to Vercel** — link project, set env vars, attach Postgres, ensure cron config, run `pnpm sync-users` after first deploy.
7. **Operations** — adding an admin, changing the channel allowlist, changing daily allowance, rotating secrets.
8. **Audit queries** — sample SQL.
9. **Smoke-test checklist** — copy of section 8.1 manual tests.

No separate `ARCHITECTURE.md` / `CONTRIBUTING.md` for v1.

## 11. Open Questions / Future Work (post-v1)

Captured here so they don't get lost; not blockers for v1:

- **Audit-log UI** in `/admin/audit` (filter by user, date range, type).
- **Vercel Blob** integration so HR can upload item images directly instead of pasting URLs.
- **Admin allowlist in DB** instead of env var, once admin count grows past ~10.
- **Reaction-removed un-give** if users actually request it (currently intentional non-feature).
- **Per-team timezone for daily reset** — would require either multiple cron entries or app-level computation; punt until needed.
- **Slack slash commands** (`/taco @bob 3`) as an alternative input modality.
- **Weekly digest** — auto-post a "top 5 of the week" message in `#taqueria` on Mondays.
- **Anti-collusion reports** — a query/report HR can run to find suspicious mutual-give patterns.
- **Multi-workspace / OAuth install flow** — only if you decide to share the bot with other companies.
- **Reaction giving with custom multi-taco emojis** (`:taco_x3:`).

## 12. Phased Build Plan (high-level)

The detailed implementation plan is produced separately by the writing-plans skill. This is the high-level phasing the plan should follow — each phase is independently shippable to a preview deploy and reviewable.

| # | Phase | Outcome |
|---|---|---|
| 1 | **Repo skeleton** | Old `.js` files deleted; Next.js 15 + TS + Tailwind initialized; `package.json` and tooling in place; `pnpm dev` boots a blank app. |
| 2 | **Database schema + migrations** | Drizzle schema for `users`, `items`, `transactions` with all CHECK constraints; first migration generated and applied. |
| 3 | **Config + env handling** | `lib/config.ts` parses and validates env vars; `.env.example` complete; typed config object exported. |
| 4 | **Slack app configuration** | New Slack app created (or manifest committed); bot scopes set; Events API URL pointed at preview deploy; OIDC scopes for Sign in with Slack added. |
| 5 | **Bolt receiver wiring** | `app/api/slack/events/route.ts` verifies signature, routes to Bolt with custom App Router receiver; ack-within-3s pattern verified end-to-end with a noop handler. |
| 6 | **Parser + give pipeline (pure)** | `parser.ts`, `give.ts` `validate` and `decide` phases written and unit-tested. No DB yet. |
| 7 | **Give pipeline — execute (DB)** | `execute` phase wired to Drizzle; full give path lives end-to-end (typed `:taco:` only); integration tests for idempotency, concurrency, CHECK constraints. |
| 8 | **Reaction giving** | `reaction_added` handler reusing the same execute path; integration tests for reaction-specific paths. |
| 9 | **Commands** | `score`, `balance`, `left`, `help`, `shop` (and French synonyms) wired for both `app_mention` and `message.im`. |
| 10 | **User sync** | `team_join` + `user_change` handlers; `scripts/sync-users.ts` for bootstrap; lazy-upsert safety nets in give path. |
| 11 | **Daily reset cron** | `vercel.json` cron entry; `/api/cron/reset-allowance` route; `CRON_SECRET` verification; manual trigger via `curl` documented. |
| 12 | **Public shop page** | `/shop` server-rendered RSC; reads active items; renders cleanly with Tailwind; copy directs to HR. |
| 13 | **Auth.js + admin gate** | `lib/auth.ts` with Slack provider + JWT + allowlist `signIn` callback; `/admin/layout.tsx` enforces it; `/api/auth/[...nextauth]/route.ts` registered. |
| 14 | **Admin items page** | `/admin/items` with table + create/edit/soft-delete server actions; integration tests on the redemption-side actions. |
| 15 | **Admin users page + redemption flow** | `/admin/users` with search, deduct modal, server action that runs the atomic redemption transaction. |
| 16 | **CI** | GitHub Actions workflow runs lint + typecheck + tests + build on every PR. |
| 17 | **README rewrite + smoke checklist** | `README.md` replaced with the structure in §10; smoke-test checklist committed. |
| 18 | **Beta deploy + cutover plan** | Production deploy to Vercel; `pnpm sync-users` run; bot invited to `#taqueria-beta`; smoke checklist executed; HeyTaco continues running in `#taqueria` until cutover. |

Each phase ends with a green CI build and a working preview deploy. Phases 1–11 produce a usable bot (no shop). Phases 12–15 add the shop + admin. Phases 16–18 are launch readiness.

## 13. Decisions Log (autonomous)

Decisions made by the AI during design that the user may want to override:

1. **Package manager: pnpm** — switchable to yarn or npm with no design impact.
2. **UTC for daily reset** — change cron expression in `vercel.json` to localize.
3. **Item images: external URLs** — paste from Imgur/Cloudinary/etc. Vercel Blob is a future-work item.
4. **Local dev DB: Neon dev branch** (over Docker Compose) — both documented; Neon recommended for fewer moving parts.
5. **CSS: Tailwind defaults** — no custom design system or branding for v1.
6. **JWT sessions over DB sessions** in Auth.js — admin count is small and re-auth on rotate is acceptable.
7. **All routes Node runtime** — Bolt requires Node; consistency over Edge benefits at this scale.
8. **No `email` column in `users` table** — Auth.js holds it in JWT; not persisted.
9. **Lazy upsert + `team_join`/`user_change`** for ongoing sync; one-shot script for bootstrap.
10. **Bolt `auth.test` on cold start** to learn bot user ID, with `SLACK_BOT_USER_ID` env var as override.
11. **Migrations in build step** for v0 simplicity; will separate later if preview deploys multiply migrations.
12. **Soft-delete-only for items** to keep historical FKs valid.
13. **Per-recipient `slack_event_id` synthesized as `${event_id}-${idx}`** to dedupe correctly across multiple recipients in one message.
14. **All-or-nothing on multi-recipient over-spend** (no best-effort split).
15. **No reaction-removed un-give** (one-way reaction giving).
16. **No time limit on reactions** — old-message reactions still count.
