# Development

How to set up, run, test, debug, and ship changes to Tacobot. Audience: contributors. For the architectural map see `architecture.md`; for the operator runbook see `operations.md`.

## Prerequisites

- Node 20+ (the repo pins via `package.json` engines).
- pnpm 9 (the lockfile is pnpm v9; npm/yarn won't work).
- A Slack app you can point at your local or preview deploy (see `slack-setup.md`).
- A Postgres URL — ephemeral local Postgres or a Vercel preview-branch database. Tests don't need one (they use PGlite in-process).

## Dev container quickstart

`.devcontainer/` provisions a Node 20 environment with zsh, GitHub CLI, GitDelta, Claude Code, and the project's Claude plugin set. Open the repo in VS Code with the **Dev Containers** extension and accept "Reopen in Container".

What it sets up:

- `node:20` base image, user `node`, workspace bound at `/workspace` with `delegated` consistency.
- Shell: zsh + Powerlevel10k + git/fzf plugins.
- Volumes for command history and Claude config so they survive rebuilds.
- `NODE_OPTIONS=--max-old-space-size=4096` so type-checking and Next.js builds don't OOM on big PRs.
- The `postCreateCommand` installs the Claude plugin marketplace + the project's plugin set (superpowers, frontend-design, context7, playwright, feature-dev, claude-md-management, typescript-lsp, chrome-devtools-mcp). Failures in this step are non-fatal.

The container does **not** seed env vars. Copy `.env.example` to `.env.local` after first launch.

### pnpm store gotcha

`.npmrc` sets `store-dir=/home/node/.pnpm-store`. The default project-local pnpm store races against bind-mounted filesystems on macOS/Linux Docker and produces sporadic `ENOENT: copyfile` errors during install. If you see that, confirm the env var is honoured (`pnpm config get store-dir`) and reinstall.

## Bare-metal local dev

```bash
pnpm install
cp .env.example .env.local        # then fill in real values
pnpm dev                          # next dev on :3000
```

The dev server reads `config.*` lazily, but the moment a route hits the Slack webhook or admin auth path, missing env vars throw. So if you only need `/` or `/shop`, you can get away with no Slack creds.

To run database-backed pages locally you need a real Postgres URL in `.env.local`. The cheapest option is a Vercel preview-branch Postgres or Neon free-tier; another is a local container (`docker run -p 5432:5432 -e POSTGRES_PASSWORD=… postgres:16`). After setting `POSTGRES_URL`, run `pnpm db:migrate` to apply the schema.

## Receiving Slack events locally

Slack must reach a public HTTPS URL to deliver events. Three options, ranked:

1. **Vercel preview deploy** (default recommendation). Push your branch; Vercel deploys it; copy the preview URL into the Slack app's Event Subscriptions. Free, reachable, and matches production semantics. The downside is iteration time (push → wait for deploy → test).
2. **`cloudflared tunnel`**. `cloudflared tunnel --url http://localhost:3000`. Stable, fast, and works behind corporate firewalls. The OAuth callback also needs to be updated in the Slack dashboard if you're testing admin sign-in.
3. **`ngrok http 3000`**. Same idea, different vendor. Free tier rotates the URL on every restart, which means re-pasting it into the Slack dashboard each time — annoying but workable.

The OAuth callback URL is the gotcha: even for local dev, Slack OIDC requires HTTPS for `Sign in with Slack`. If you only want to test the Slack-events path (give/reaction), no OAuth changes needed.

## Tests

```bash
pnpm test            # one-shot
pnpm test:watch      # watch mode
```

Vitest config (`vitest.config.ts`):

- Node environment, `forks` pool, 10s test timeout.
- Setup file at `tests/setup.ts` (currently a placeholder; per-suite hooks live with the tests).
- Globals disabled — import everything explicitly. (`import { describe, it, expect } from "vitest"`).
- Path alias `@` → repo root.

### Unit vs. integration

| Layer | Where | What's tested |
| --- | --- | --- |
| Unit | `tests/unit/` | Pure functions: `parser`, `format`, `give.validate`, `give.decide`, `receiver.verify`, `userInfo.resolveUserName`, date helpers. Fast, no DB. |
| Integration | `tests/integration/` | Real handlers + real DB (PGlite): constraints, `users` upsert/ensure, `executeGive`, redemption, reaction give, message-delete reversal, reaction-removed reversal, reversal counters, cron reset, leaderboard command. |

Pure logic stays unit-testable so it can be exercised without spinning up PGlite. If you find yourself needing a DB in a unit test, the function probably belongs in `lib/db/queries.ts` (and the test in `tests/integration/`).

### PGlite + isolation helpers

`tests/integration/helpers/db.ts` exports:

- `getDb()` — lazy-init a single in-process PGlite, run all migrations from `drizzle/*.sql` (split on `--> statement-breakpoint`), and return a Drizzle handle. The DB is shared across the suite.
- `inRollbackTx(fn)` — open a SAVEPOINT, run `fn`, roll it back. Per-test isolation with no truncate cost. Default choice.
- `withCleanDb(fn)` — `TRUNCATE … RESTART IDENTITY CASCADE` before and after `fn`. Use only when a test needs multiple connections (PGlite is single-connection but in-process serialization works).
- `closePool()` — call from a top-level `afterAll` if your test file leaks pglite handles.

Pattern:

```ts
import { describe, it, expect } from "vitest";
import { inRollbackTx } from "./helpers/db";

describe("redemption", () => {
  it("rejects insufficient balance", async () => {
    await inRollbackTx(async (db) => {
      // seed, exercise, assert — rolled back automatically
    });
  });
});
```

CI uses the same path; no Docker, no Postgres service container.

## Adding a Drizzle migration

1. Edit `lib/db/schema.ts`.
2. `pnpm db:generate` — drizzle-kit writes a new `drizzle/NNNN_*.sql` file.
3. Inspect the SQL. Drizzle is good but not perfect; double-check CHECK clauses and partial indexes.
4. `pnpm db:migrate` — applies it locally if you have `POSTGRES_URL` set.
5. Commit both the schema change and the migration file.

**Never edit a migration after it's merged.** If the change was wrong, write a new migration that fixes it.

The build script (`pnpm build`) runs `db:migrate` before `next build`, so deploys auto-migrate. This means a broken migration breaks the deploy — test it locally first.

## Debugging

- **Bolt event log**: drop `console.log("event", event.type, event)` at the top of any handler in `lib/slack/handlers/`. Vercel's function logs surface it. Don't log raw bodies in production — they include user message content.
- **Drizzle Studio**: `pnpm db:studio` opens a web UI against the configured database. Read-only inspection is the safest tool for "what's the actual state right now?"
- **Receiver-level traces**: `[AppRouterReceiver] processEvent threw …` is logged on uncaught handler exceptions (see `lib/slack/receiver.ts:71`). Add `console.error` upstream if you need to see the request that produced it.
- **Auth.js**: the `signIn` callback (`lib/auth.ts:14`) is the gate that rejects non-admins. If sign-in seems broken, log `profile` there to see the OIDC claims Slack actually sent — `https://slack.com/user_id` is the Slack workspace ID we allowlist against, with `sub` as fallback.
- **Slack signature mismatches**: log the timestamp + signature header from the request; verify your `SLACK_SIGNING_SECRET` value matches the dashboard. The 5-minute replay window means tests against captured fixtures expire fast.
- **`processBeforeResponse: true` quirk**: handlers must not be slow. If a Slack call inside a handler hangs, the function holds the response too. Wrap external calls in `try/catch` and log the failure (we already do this for `reactions.add` and `chat.postMessage` — see `handlers/message.ts:118`).

## CI

`.github/workflows/ci.yml` triggers on push to `main`/`master` and any pull request:

```yaml
- pnpm install --frozen-lockfile
- pnpm typecheck
- pnpm lint
- pnpm test
```

No secrets needed. PGlite means no DB service container. CI is fast (typically <2 minutes). Treat green-on-PR as the bar for merging.

## Code style

- Prettier (`.prettierrc`): `semi: true`, double quotes, trailing comma `all`, 100-col width, 2-space indent. VS Code's Prettier plugin is configured to format on save in the dev container.
- ESLint flat config (`eslint.config.mjs`): extends Next.js core-web-vitals + TypeScript. Unused variables are warnings unless prefixed with `_`.
- TypeScript strict, ES2022 target, bundler resolution. Path alias `@/…` resolves to repo root.

Run `pnpm typecheck && pnpm lint && pnpm test` before claiming done. CI runs the same three commands and blocks merges if any fail.

## Release / deploy lifecycle

Push to `master` → Vercel runs `pnpm build` → `pnpm db:migrate` applies any pending migrations → `next build` produces the SSR bundle → cron jobs from `vercel.json` register automatically.

Preview branches behave the same way (each gets its own URL and, if you've configured per-branch databases, its own Postgres). Use a preview branch when you need Slack to actually deliver events to your changes.
