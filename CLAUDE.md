# CLAUDE.md

Guidance for Claude Code (and human contributors) working on Tacobot. Keep this file accurate; an outdated CLAUDE.md is worse than none.

## What this is

Tacobot is a Slack `:taco:` recognition bot with an admin shop. Users react with 🌮 (or post `<@user> :taco: :taco:`) in allowlisted channels; recipients accumulate a `balance` they spend in `/shop` via HR-mediated redemption. Daily allowance resets at 00:00 UTC.

**Stack:** Next.js 15 (App Router) + TypeScript + Tailwind on Vercel · `@slack/bolt` v4 with a custom App-Router receiver · Vercel Postgres + Drizzle ORM · Auth.js v5 with Slack OIDC for `/admin` · Vitest with `@electric-sql/pglite` for in-process integration tests · Node 20, pnpm 9.

User-facing overview lives in `README.md`. Architectural deep-dive lives in `docs/architecture.md`.

## Repo layout

```
app/
  layout.tsx                       Root layout, metadata, favicons
  page.tsx                         Landing
  shop/page.tsx                    Public catalog (ISR, revalidate=60); renders HR contact link
  admin/layout.tsx                 Auth gate: redirects unauthenticated to signin
  admin/page.tsx                   Admin home
  admin/users/{page,actions}.tsx   User table + redemption form (deductTacos)
  admin/items/{page,actions}.tsx   Items CRUD + Vercel Blob upload
  api/auth/[...nextauth]/route.ts  Auth.js handlers
  api/slack/events/route.ts        Bolt webhook: getReceiver().handle(req)
  api/cron/reset-allowance/        Daily reset; verified via Bearer ${CRON_SECRET}

lib/
  config.ts                        Lazy env-var getters (see Invariants)
  auth.ts                          NextAuth + Slack OIDC + admin allowlist gate
  db/
    client.ts                      Drizzle client over @vercel/postgres
    schema.ts                      users, items, transactions; CHECK constraints
    queries.ts                     upsertUser, ensureUserExists, listActiveItems
    types.ts                       DbLike (Postgres / pglite-compatible)
  slack/
    bolt.ts                        Lazy singleton App + Receiver factories
    receiver.ts                    AppRouterReceiver: HMAC verify, URL handshake
    handlers.ts                    registerAllHandlers() — wires the four below
    handlers/message.ts            Channel `:taco:` mention → give; `message_deleted` → reverse all gives on that message
    handlers/reaction.ts           `reaction_added` → 1-taco give; `reaction_removed` → reverse the reactor's give(s)
    handlers/commands.ts           App mentions + DMs: score/balance/left/shop/help
    handlers/userSync.ts           team_join + user_change → upsert/deactivate
    give.ts                        validate() + decide() — pure domain logic
    execute.ts                     executeGive() — transactional with idempotency
    reverse.ts                     executeMessageReversal() / executeReactionReversal() — append-only compensation
    parser.ts                      countTacos, findUserIds
    format.ts                      Slack message strings
    userInfo.ts                    resolveUserName with 1h TTL + in-flight dedup
    botUserId.ts                   getBotUserId() singleton
  admin/redeem.ts                  redeem() — transactional balance deduction

drizzle/                           Generated migrations (commit them)
scripts/sync-users.ts              One-shot bootstrap from Slack users.list
tests/unit/                        Pure-logic tests (parser, format, decide, validate, receiver-verify)
tests/integration/                 PGlite tests (constraints, execute, redemption, reaction, cron, command-score)
tests/integration/helpers/db.ts    getDb(), inRollbackTx(), withCleanDb()
.github/workflows/ci.yml           typecheck + lint + test on push/PR
vercel.json                        Cron: `0 0 * * *` → /api/cron/reset-allowance
```

## Commands

```bash
pnpm install
pnpm dev                 # Next dev server on :3000
pnpm build               # runs `db:migrate` then `next build`
pnpm typecheck           # tsc --noEmit
pnpm lint                # eslint .
pnpm test                # vitest run
pnpm test:watch          # watch mode
pnpm db:generate         # drizzle-kit generate (after schema edits)
pnpm db:migrate          # drizzle-kit migrate
pnpm db:studio           # drizzle-kit studio (web UI)
pnpm sync-users          # bootstrap users from Slack workspace
```

CI runs `typecheck && lint && test` on every push and PR. Always run those locally before claiming done.

## Critical invariants

These are load-bearing. Don't paper over them — fix the underlying issue.

- **Lazy env validation** (`lib/config.ts`). Properties are getters; reading them throws if the env var is missing. This lets `next build` import route modules without secrets. Never access env at module-top scope; always go through `config.*`.
- **Lazy Bolt singletons** (`lib/slack/bolt.ts`). `getReceiver()` and `getBoltApp()` memoize. `next build` must not require Slack secrets.
- **`processBeforeResponse: true`** is set on the Bolt App (FaaS-correct on Vercel — the function stays alive until handlers finish). Slack's 3-second ack still applies to total handler runtime; budget <500ms per event.
- **URL-verification short-circuits** before Bolt dispatch in `lib/slack/receiver.ts`. Don't move signature-verify around it.
- **HMAC-SHA256 signature verify** with a 5-minute replay window and `crypto.timingSafeEqual` (`lib/slack/receiver.ts:84`). The receiver reads the raw body via `req.text()` — never `req.json()` first, or the signature won't match.
- **Atomic give** (`lib/slack/execute.ts:20`): `UPDATE users SET dailyRemaining = dailyRemaining - N WHERE id = … AND dailyRemaining >= N RETURNING id`. If the UPDATE returns 0 rows, the transaction rolls back as `over_allowance`. Never read-then-write.
- **Atomic redeem** (`lib/admin/redeem.ts:17`): same pattern on `balance`. The atomic `WHERE balance >= amount` (not a DB CHECK — `balance >= 0` was relaxed) is what prevents overdraw on redemption.
- **Append-only reversals** (`lib/slack/reverse.ts`): undoing a give writes a `type='reversal'` row referencing the original via `reversed_transaction_id` (UNIQUE). Counters update too: recipient's `balance`/`receivedTotal` decrement (allowed to go negative), giver's `daily_remaining` is restored capped at `dailyAllowance`. Never UPDATE/DELETE existing transactions — always insert compensation.
- **Idempotency**: each individual taco is its own `transactions` row keyed by `slack_event_id`. Composite forms: `${envelopeEventId}-${idx}` for messages, `react-${channel}-${ts}-${reactor}-${idx}` for reactions, `delete-${original.id}` / `unreact-${original.id}` for reversals. The UNIQUE constraint + `onConflictDoNothing` makes Slack retries safe; for gives, if any insert returns 0 rows the whole give rolls back as `duplicate`. For reversals, per-row `onConflictDoNothing` on `reversed_transaction_id` lets a partial run resume cleanly.
- **DB CHECK constraints** (`lib/db/schema.ts`): `dailyRemaining >= 0`, `balance <= receivedTotal`, `priceTacos > 0`, `quantity > 0 OR NULL`, unique `lower(name)` among active items, three-way row shape (give: `fromUserId` set, no admin/item/reversal-ref, no self-give; redeem: `adminUserId` + `itemId` set, no `fromUserId`/reversal-ref; reversal: only `toUserId` and `reversedTransactionId` set, plus UNIQUE on `reversedTransactionId` to block double-reversal). `balance` and `receivedTotal` *may* be negative — they decrement together when a give is reversed after the recipient has already redeemed. Don't bypass with raw SQL.
- **Auth.js admin gate** (`lib/auth.ts:14`) lives in the `signIn` callback, not a layout redirect. Non-admins never get a session. The admin layout still redirects unauthenticated visitors to `/api/auth/signin?callbackUrl=/admin`.
- **User-name freshness** (`lib/slack/userInfo.ts`): 1-hour TTL cache + in-flight dedup. Score/leaderboard renders `<@USERID>` mentions so Slack handles current display name + avatar — we never have to re-render the cached name.

## Conventions

- TypeScript strict, ESM, Next.js App Router. React 19 server components by default; opt into `"use client"` only when you need it.
- Drizzle queries belong in `lib/db/queries.ts`; don't scatter ORM calls across handlers.
- Slack handlers belong in `lib/slack/handlers/`. Pure logic (validate, decide, parse, format) belongs in sibling files and stays unit-testable.
- Tests: unit under `tests/unit/`, integration under `tests/integration/` using PGlite. `inRollbackTx` (per-test SAVEPOINT) is the default; use `withCleanDb` only when a test needs multiple connections.
- Prettier (`.prettierrc`): `semi: true`, double quotes, trailing-comma `all`, 100 cols, 2-space indent. ESLint flat config in `eslint.config.mjs`.
- Commit messages match the existing repo style: lower-case `type(scope): summary` (e.g. `feat(items): quantity, redemption instructions, image upload`).

## Common gotchas

- Don't add a second daily-allowance source — read `config.taco.dailyAllowance` only.
- Don't bypass `validate()` → `decide()` → `executeGive()`. The chain encodes channel allowlist, dedup, self-give filter, and atomicity. Same shape for reactions in `lib/slack/handlers/reaction.ts:processReaction`.
- Don't `req.json()` before HMAC verify — JSON parse can canonicalize whitespace/key order and break the signature.
- Adding a new env var means three edits: a getter in `lib/config.ts`, a row in `.env.example` (with comment), and a row in the README env table.
- Adding a DB column means: edit `lib/db/schema.ts`, run `pnpm db:generate`, commit the new file under `drizzle/`. Never edit a migration after merge.
- The Vercel cron expression in `vercel.json` doesn't interpolate env vars. Timezone changes are file-edit + redeploy.
- The cron route accepts both POST and GET (Vercel's behaviour varies). Both verify `Authorization: Bearer ${CRON_SECRET}`.
- The reaction handler resolves the message author via `conversations.history` (the `reaction_added` payload doesn't include it). Failure there silently drops the event.
- Slack types `event` as a discriminated union — narrow with `if ("user" in event)` / `event.subtype === …` rather than casting.
- **Re-react after unreact is silently ignored.** A reaction's give uses `slack_event_id = react-${channel}-${ts}-${reactor}-${idx}`, so removing then re-adding the same reaction tries to INSERT the identical key and `onConflictDoNothing` no-ops. The original give is permanently reversed; the new reaction has no effect. Pre-existing limitation; matches the same key collision that protects against Slack retries.
- **Adding `reaction_removed` (or any new event)** means subscribing to it in the Slack app dashboard (`docs/slack-setup.md`) — not just registering it in `lib/slack/handlers.ts`.
- **`message_deleted` reverses across the full message scope**, including `:taco:` reactions left by other people. The reactors are notified by DM. This matches Slack's own behavior (their reactions disappear with the message).

## Where things live for common tasks

| Task | File(s) |
| --- | --- |
| Add a DM/mention command | `lib/slack/handlers/commands.ts` (regex + `dispatch()`) |
| Change give/over-allowance message wording | `lib/slack/format.ts` |
| Add a shop-item field | `lib/db/schema.ts` → `pnpm db:generate` → `app/admin/items/{page,actions}.tsx` → `app/shop/page.tsx` |
| Change daily-reset time | `vercel.json` cron expression |
| Change give/redeem rules | `lib/slack/give.ts` + `lib/slack/execute.ts` (or `lib/admin/redeem.ts`) |
| Change reversal rules (delete/unreact) | `lib/slack/reverse.ts` + handlers in `lib/slack/handlers/{message,reaction}.ts` |
| Bootstrap users from Slack | `pnpm sync-users` (`scripts/sync-users.ts`) |
| Add an admin | env: `ADMIN_SLACK_IDS` (comma-separated Slack IDs) + redeploy |
| Add the HR contact link to `/shop` | env: `HR_SLACK_ID` + `HR_SLACK_HANDLE` |
| Channel allowlist | env: `TACO_CHANNELS` |

For a deeper map (data flow, idempotency, concurrency model), see `docs/architecture.md`. For the operator runbook (deploy, audit queries, smoke tests), see `docs/operations.md`. For local-dev specifics (devcontainer, ngrok, testing patterns), see `docs/development.md`.
