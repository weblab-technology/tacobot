# Tacobot 🌮

Internal Slack recognition program for the `wlt-and-shaman` workspace. Inspired by [HeyTaco](https://www.heytaco.com/).

Give 🌮 reactions to teammates in `#taqueria`. Every employee has a daily allowance (default 5). Tacos accumulate as a `balance` that can be redeemed in the [shop](#) — HR-mediated.

## Stack

Next.js 15 + TypeScript + Tailwind on Vercel Pro · Bolt for JS (Slack Events API) · Vercel Postgres + Drizzle ORM · Auth.js v5 + Slack OIDC for the admin pages · Vitest with [pglite](https://github.com/electric-sql/pglite) for in-process integration tests.

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

The dev container (or any local machine) needs Node 20 and pnpm. The first install requires the project's `.npmrc` setting (`store-dir=/home/node/.pnpm-store`) to avoid a copyfile race with pnpm's default project-local store on bind-mounted filesystems.

```bash
pnpm install
```

### Run the dev server

```bash
pnpm dev
```

The dev server crashes if `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` aren't set (config validation throws at module load). Provide them via `.env.local`.

### Tests

Integration tests run against an in-process pglite (PGlite) — no Docker, no real Postgres needed locally:

```bash
pnpm test
pnpm test:watch     # watch mode
```

### Slack event delivery during dev

Slack must reach a public URL to deliver events. For local dev:

1. `ngrok http 3000` (or `cloudflared tunnel`).
2. Update the Slack app's Event Subscriptions URL to the ngrok URL with path `/api/slack/events`.
3. Don't forget to set Slack app's OAuth redirect URL to the ngrok URL too if testing admin sign-in locally.

For most development, deploying to a Vercel preview branch is simpler than running locally — Vercel preview deploys are free and reachable from Slack.

## Deploying to Vercel

1. Link the project: `vercel link` from the repo, or use the Vercel dashboard "Import Git Repository" flow.
2. In Vercel → **Storage**, create a Postgres / Neon database. This auto-injects `POSTGRES_URL` and friends.
3. Set the env vars from the table above in the Vercel project settings.
4. The `vercel.json` already declares the daily-reset cron at `0 0 * * *` (UTC midnight). It appears in **Settings → Cron Jobs** after first deploy.
5. Push to the deploy branch; Vercel runs `pnpm build` (which includes `pnpm db:migrate`) and `next build`.
6. After the first deploy, run `pnpm sync-users` once locally with the production `POSTGRES_URL` set in `.env.local`, to bulk-import existing workspace members.

## Operations

### Add an admin

Update `ADMIN_SLACK_IDS` in Vercel env vars (comma-separated). Redeploy.

### Change channel allowlist

Update `TACO_CHANNELS`. Redeploy. (No data migration needed — past transactions reference the channel they were sent in.)

### Change daily allowance

Update `TACO_DAILY_ALLOWANCE`. The next daily reset (00:00 UTC) refills everyone to the new value.

### Change the daily-reset timezone

Edit the cron expression in `vercel.json`. Vercel Cron schedules don't interpolate env vars, so the timezone is fixed in the file. Default `0 0 * * *` is UTC midnight; e.g. `0 8 * * *` would be 08:00 UTC (10:00 in Western Europe).

### Rotate Slack signing secret

Regenerate in Slack app dashboard → update Vercel env → redeploy. No DB changes.

### Inspect data

`pnpm db:studio` opens Drizzle Studio against the configured database.

## Audit queries

The `transactions` table is the audit log. Sample queries:

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

Run after every deploy in `#taqueria-beta`:

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
- [ ] Next morning: confirm `daily_remaining` reset to the configured allowance.

## Architecture notes

See [docs/superpowers/specs/2026-05-02-tacobot-rebuild-design.md](docs/superpowers/specs/2026-05-02-tacobot-rebuild-design.md) for the design spec, and [docs/bolt-app-router-notes.md](docs/bolt-app-router-notes.md) for verified patterns on Bolt + Auth.js with Next.js App Router.

## License

Internal use, not published.
