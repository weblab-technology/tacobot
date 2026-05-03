# Operations

Runbook for the operator who owns the Tacobot deployment. Covers post-deploy checks, audit queries, common ops events, and where to look when something looks wrong. Setup and env vars live in `README.md`; architecture lives in `architecture.md`.

## Smoke-test checklist

Run this after every deploy. Use the beta channel listed in `TACO_CHANNELS` and a couple of test accounts.

- [ ] Bot is online and a member of every channel listed in `TACO_CHANNELS` (`/invite @tacobot` if not).
- [ ] Type `<@teammate> :taco:` in an allowlisted channel. Recipient's `received_total` and `balance` increment, your `daily_remaining` decrements, your message gets a 🌮 reaction from the bot.
- [ ] React to a teammate's message with 🌮. Their balance increments by 1.
- [ ] DM `@tacobot score` — replies with top 5 by lifetime received, names rendered as Slack mentions.
- [ ] DM `@tacobot balance` — replies with your current balance and the shop URL.
- [ ] DM `@tacobot left` — replies with your remaining daily allowance.
- [ ] DM `@tacobot help` — replies with the command list.
- [ ] Try giving yourself a taco (`<@you> :taco:`) — silently no-ops.
- [ ] Try giving more tacos than you have left — gets an ephemeral over-allowance message; no DB change.
- [ ] Open `/shop` (logged out is fine) — items render. The HR contact link points at `HR_SLACK_HANDLE` (or the literal string "HR" if `HR_SLACK_ID` isn't set).
- [ ] Sign in to `/admin/items` with an admin Slack account — add a test item with a name, price, and either an uploaded image or pasted URL. It appears on `/shop` (give ISR up to 60s, or hard-refresh).
- [ ] Sign in to `/admin/users` — pick a test user, choose the new item, deduct tacos. Their `balance` drops, a `transactions` row is recorded with `type='redeem'`.
- [ ] Sign-in attempt as a non-admin Slack account — bounces back to sign-in (no session is created).
- [ ] Trigger `/api/cron/reset-allowance` manually with `Authorization: Bearer ${CRON_SECRET}` — response `{ updated: <count> }`. All active users' `daily_remaining` is back to `TACO_DAILY_ALLOWANCE`.

## Audit queries

The `transactions` table is the audit log. Run via `pnpm db:studio` or `psql $POSTGRES_URL`.

### Lifetime totals

```sql
-- Top givers (lifetime)
SELECT u.name, COUNT(*) AS gives, SUM(t.amount) AS tacos_given
FROM transactions t
JOIN users u ON u.id = t.from_user_id
WHERE t.type = 'give'
GROUP BY u.name
ORDER BY tacos_given DESC
LIMIT 20;

-- Top receivers (lifetime)
SELECT u.name, SUM(t.amount) AS tacos_received
FROM transactions t
JOIN users u ON u.id = t.to_user_id
WHERE t.type = 'give'
GROUP BY u.name
ORDER BY tacos_received DESC
LIMIT 20;
```

### Monthly digest

```sql
-- Per-month give volume
SELECT date_trunc('month', created_at) AS month,
       COUNT(*)         AS give_events,
       SUM(amount)      AS tacos_moved,
       COUNT(DISTINCT from_user_id) AS unique_givers,
       COUNT(DISTINCT to_user_id)   AS unique_receivers
FROM transactions
WHERE type = 'give'
GROUP BY 1 ORDER BY 1 DESC;

-- This month's leaderboard
SELECT u.name, SUM(t.amount) AS received
FROM transactions t
JOIN users u ON u.id = t.to_user_id
WHERE t.type = 'give'
  AND t.created_at >= date_trunc('month', now())
GROUP BY u.name ORDER BY received DESC LIMIT 10;
```

### Redemption history

```sql
-- All redemptions in a quarter, with the admin who processed each
SELECT u.name AS employee, i.name AS item, t.amount, t.reason, t.created_at,
       a.name AS admin
FROM transactions t
JOIN users u ON u.id = t.to_user_id
JOIN items i ON i.id = t.item_id
LEFT JOIN users a ON a.id = t.admin_user_id
WHERE t.type = 'redeem'
  AND t.created_at >= '2026-04-01' AND t.created_at < '2026-07-01'
ORDER BY t.created_at DESC;

-- Item popularity (lifetime)
SELECT i.name, COUNT(*) AS redemptions, SUM(t.amount) AS tacos_spent
FROM transactions t
JOIN items i ON i.id = t.item_id
WHERE t.type = 'redeem'
GROUP BY i.name
ORDER BY redemptions DESC;
```

### Per-channel breakdown

```sql
SELECT slack_channel_id,
       COUNT(*)    AS gives,
       SUM(amount) AS tacos
FROM transactions
WHERE type = 'give'
GROUP BY slack_channel_id
ORDER BY tacos DESC;
```

### Suspicious-burst detection

```sql
-- Users who gave 20+ tacos in a single calendar day
SELECT from_user_id,
       date_trunc('day', created_at) AS day,
       COUNT(*) AS gives,
       SUM(amount) AS tacos
FROM transactions
WHERE type = 'give'
GROUP BY from_user_id, day
HAVING SUM(amount) >= 20
ORDER BY tacos DESC;
```

If `TACO_DAILY_ALLOWANCE = 5` you should never see >5 from one user in one UTC day. If you do, either someone changed the allowance mid-day or there's a bug in the give path; pull the matching `transactions` rows by `slack_event_id` and confirm against Slack's event-delivery dashboard.

### Balance reconciliation

```sql
-- Sum of (received via gives) − (spent via redemptions) should equal users.balance for every user.
SELECT u.id, u.name, u.balance,
       COALESCE(SUM(CASE WHEN t.type = 'give'   THEN t.amount END), 0)
       - COALESCE(SUM(CASE WHEN t.type = 'redeem' THEN t.amount END), 0) AS computed_balance
FROM users u
LEFT JOIN transactions t ON t.to_user_id = u.id
GROUP BY u.id, u.name, u.balance
HAVING u.balance <>
       COALESCE(SUM(CASE WHEN t.type = 'give'   THEN t.amount END), 0)
       - COALESCE(SUM(CASE WHEN t.type = 'redeem' THEN t.amount END), 0);
```

A row in this result means the audit log doesn't match the cached counter. The DB CHECK constraints make this near-impossible to produce, so a non-empty result is a strong signal of either a bug in the give/redeem path or a manual SQL edit. Investigate before "fixing" the counter.

### Permalink for a give

```sql
SELECT 'https://wlt-and-shaman.slack.com/archives/' || slack_channel_id ||
       '/p' || replace(slack_message_ts, '.', '')
FROM transactions WHERE id = '<txn-id>';
```

(Replace the workspace subdomain. The `p…` permalink format is Slack's, with the dot stripped from the message timestamp.)

## Runbooks

### Add or remove an admin

1. Update `ADMIN_SLACK_IDS` (comma-separated) in Vercel → Settings → Environment Variables.
2. Redeploy. Existing admin sessions stay valid until JWT expiry; revoked admins lose access on next sign-in.

### Change the channel allowlist

1. Update `TACO_CHANNELS`. Comma-separated channel IDs (right-click → View channel details → ID at the bottom).
2. Redeploy.
3. `/invite @tacobot` in any newly-added channel — the bot must be a member for `message.channels` events to be delivered.
4. No data migration needed; past `transactions` rows reference the channel they were sent in.

### Change the daily allowance

1. Update `TACO_DAILY_ALLOWANCE`. Must be a positive integer.
2. Redeploy. The next daily reset (00:00 UTC) refills everyone to the new value. Until then, anyone who's already given tacos today keeps their old `daily_remaining`.

### Change the daily-reset time / timezone

`vercel.json` cron expressions are UTC and don't interpolate env vars.

```json
{ "crons": [{ "path": "/api/cron/reset-allowance", "schedule": "0 0 * * *" }] }
```

Edit `0 0 * * *` (UTC midnight) to whatever you need (`0 8 * * *` = 08:00 UTC, ~10:00 in Western Europe). Commit, redeploy. The new schedule registers automatically.

### Rotate the Slack signing secret

1. Slack app dashboard → **Basic Information** → regenerate the signing secret.
2. Update `SLACK_SIGNING_SECRET` in Vercel.
3. Redeploy.
4. There's a brief window after dashboard regeneration but before redeploy where Slack signs with the new secret but our deployment expects the old one. Events in that window get 401'd; Slack will retry, so it self-heals once the redeploy lands. Keep the window short.

### Rotate the bot OAuth token

1. Slack app dashboard → **OAuth & Permissions** → **Reinstall to Workspace**. Approve.
2. Copy the new `xoxb-…` token.
3. Update `SLACK_BOT_TOKEN` in Vercel.
4. Redeploy.

### Rotate `CRON_SECRET`

Vercel auto-manages this; you don't normally rotate it. If you must (e.g. it leaked), regenerate via the Vercel dashboard's environment variables UI; the cron continues to work because Vercel signs requests with the current value.

### Reseed users after a large org change

If many people joined/left at once (acquisition, layoff, contractor wave) and `team_join` / `user_change` events were missed, run:

```bash
pnpm sync-users
```

against the production `POSTGRES_URL` (set in `.env.local`). It paginates through `users.list` (200/page), upserts active members with their resolved display names, and flips `is_active = false` for any user it doesn't see. Safe to run any time; idempotent.

### Recover from a stuck cron

If the daily reset didn't run, hit the endpoint manually from somewhere with the secret:

```bash
curl -X POST "https://<deploy-host>/api/cron/reset-allowance" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Returns `{ "updated": <count> }`. Idempotent — running it twice in a day just resets twice (which only matters if someone gave tacos in between, in which case their day starts fresh).

### Manual balance correction

There is no "undo" UI by design; the audit log is append-only. To compensate:

- Small adjustment, in-band: have a workspace admin give the user the right number of `:taco:` reactions in `#taqueria`.
- Large or HR-tracked adjustment: have an engineer issue a single correcting `transactions` row with a clear `reason` (e.g. "manual correction — over-redeemed at all-hands 2026-Q2"). Done in `pnpm db:studio` or a one-shot script. Update the cached `users.balance` / `users.received_total` in the same transaction so CHECK constraints stay satisfied.

Never edit a row in place — that destroys the audit trail. Always insert a compensating row.

## Monitoring

| What to watch | Where |
| --- | --- |
| Function errors (Slack webhook, cron, server actions) | Vercel → Project → **Logs** (filter by function path) |
| Cron history | Vercel → Project → **Settings → Cron Jobs** |
| Slack event delivery | Slack app dashboard → **Event Subscriptions** → **Recent deliveries** |
| OAuth / sign-in failures | Vercel logs for `/api/auth/*`. 401 on sign-in usually means the user isn't in `ADMIN_SLACK_IDS`. |
| Database load | Vercel Postgres / Neon dashboard |

### Failure-mode cheatsheet

| Symptom | Likely cause |
| --- | --- |
| Slack events return 401 | `SLACK_SIGNING_SECRET` mismatch (after rotation, before redeploy) or someone replaying old requests outside the 5-minute replay window. |
| Slack events return 500 | Handler threw. Check Vercel logs; the receiver logs `[AppRouterReceiver] processEvent threw`. |
| URL verification fails when changing the events URL | Make sure the new URL is reachable and the deploy is live before saving in Slack — the dashboard waits for a `200 { challenge: … }` synchronously. |
| Bot does nothing in a channel | Channel not in `TACO_CHANNELS`, or bot not invited (`/invite @tacobot`). |
| `/admin` redirects in a loop | Signed-in user is not in `ADMIN_SLACK_IDS`. The Auth.js `signIn` callback returns false; no session is ever created. |
| Cron returns 401 | `CRON_SECRET` mismatch or missing `Authorization` header. Vercel injects this automatically for scheduled invocations; manual hits need it explicit. |
| `pnpm build` fails on Vercel with "Missing required env var: POSTGRES_URL" | The `db:migrate` step in the build script needs `POSTGRES_URL`. Connect a Postgres / Neon integration in Vercel Storage so it's auto-injected. |
