# Operations

Runbook for the operator who owns the Tacobot deployment. Covers post-deploy checks, audit queries, common ops events, and where to look when something looks wrong. Setup and env vars live in `README.md`; architecture lives in `architecture.md`.

## Smoke-test checklist

Run this after every deploy. Use the beta channel listed in `TACO_CHANNELS` and a couple of test accounts.

- [ ] Bot is online and a member of every channel listed in `TACO_CHANNELS` (`/invite @tacobot` if not).
- [ ] Type `<@teammate> :taco:` in an allowlisted channel. Recipient's `received_total` and `balance` increment, your `daily_remaining` decrements, and you get a DM from the bot confirming the give. **If `TACO_REACT_ON_GIVE=true`**: your message also gets a 🌮 reaction (or `:${TACO_ALT_EMOJI_NAME}:` if set) from the bot. Default is off — verify no bot reaction lands when the flag is unset.
- [ ] React to a teammate's message with 🌮. Their balance increments by 1.
- [ ] **If `TACO_ALT_EMOJI_NAME` is set**: type a give using the alt emoji (`<@teammate> :wltaco:`) and react to a message with the alt emoji. Both should count exactly like `:taco:`. (And if `TACO_REACT_ON_GIVE=true`, the bot's confirmation reaction should be the alt emoji.)
- [ ] DM `@tacobot score` — replies with top 5 by lifetime received, names rendered as Slack mentions.
- [ ] DM `@tacobot balance` — replies with your current balance and the shop URL.
- [ ] DM `@tacobot left` — replies with your remaining daily allowance.
- [ ] DM `@tacobot help` — replies with the command list.
- [ ] Try giving yourself a taco (`<@you> :taco:`) — silently no-ops.
- [ ] Try giving more tacos than you have left — gets an ephemeral over-allowance message; no DB change.
- [ ] **Reverse a give by removing the reaction**: react with 🌮, confirm the recipient's balance went up, then remove the reaction. A `type='reversal'` row is inserted for that give; the recipient's `balance`/`received_total` decrement; your `daily_remaining` is restored (capped at `TACO_DAILY_ALLOWANCE`); both parties get a DM.
- [ ] **Reverse a give by deleting the message**: post `<@teammate> :taco: :taco:`, confirm gives landed, then delete the message in Slack. A reversal row per give is inserted (including any 🌮 reactions other people left on that message); counters update; the message author and each affected reactor/recipient are DM'd.
- [ ] Re-react after unreact: the original give is permanently gone (Slack retries on the same composite event ID `react-…-${reactor}-${idx}` collide with `onConflictDoNothing`), so a re-add is silent. Confirm no second give appears in `transactions`.
- [ ] Open `/shop` (logged out is fine) — items render. The HR contact link points at `HR_SLACK_HANDLE` (or the literal string "HR" if `HR_SLACK_ID` isn't set).
- [ ] Sign in to `/admin/items` with an admin Slack account — add a test item with a name, price, and either an uploaded image or pasted URL. It appears on `/shop` (give ISR up to 60s, or hard-refresh).
- [ ] Sign in to `/admin/users` — pick a test user, choose the new item, deduct tacos. Their `balance` drops, a `transactions` row is recorded with `type='redeem'`.
- [ ] Open `/admin/activity` — your test gives appear at the top with the right giver/recipient/channel, the all-time total includes them, and the channel filter dropdown lists the test channel. Test gives you reversed earlier in this checklist show the ↺ **reversed** or ↺ **partially reversed** pill.
- [ ] Open `/admin/leaderboard` — switch metric (received/given/combined), period (today/week/month/all-time), and channel filters. The page auto-refreshes on each change; your test gives are reflected; reversed gives are excluded; ties share a rank.
- [ ] On `/admin/users`, use the **Adjust** form on a test user with `+1` and a reason. Confirm dialog appears; on accept, balance and `received_total` both go up by 1, a `type='grant'` row is recorded, and the test user gets a DM from the bot. Then apply `-1` with a reason; the negative-warning line appears in the confirm; balance drops; another grant row is recorded. Finally try `0` — rejected ("amount must be a non-zero integer").
- [ ] Sign-in attempt as a non-admin Slack account — bounces back to sign-in (no session is created).
- [ ] Trigger `/api/cron/reset-allowance` manually with `Authorization: Bearer ${CRON_SECRET}` — response `{ updated: <count> }`. All active users' `daily_remaining` is back to `TACO_DAILY_ALLOWANCE`.

## Audit queries

The `transactions` table is the append-only audit log. Four row types: `give`, `redeem`, `reversal`, `grant`. A `reversal` references the original `give` via `reversed_transaction_id` and never modifies it; a `grant` is an admin-issued signed adjustment (positive or negative). Most analytics want "net" numbers — gives that weren't reversed — so queries below subtract reversed gives explicitly. Grants don't appear in give/receive analytics by default (they aren't peer-to-peer recognition); they show up in reconciliation and in dedicated grant queries.

Run via `pnpm db:studio` or `psql $POSTGRES_URL`.

### Lifetime totals

```sql
-- Top givers (lifetime, NET — excludes reversed gives)
SELECT u.name,
       COUNT(*) FILTER (WHERE r.id IS NULL) AS gives,
       COALESCE(SUM(t.amount) FILTER (WHERE r.id IS NULL), 0) AS tacos_given
FROM transactions t
JOIN users u ON u.id = t.from_user_id
LEFT JOIN transactions r ON r.reversed_transaction_id = t.id
WHERE t.type = 'give'
GROUP BY u.name
ORDER BY tacos_given DESC
LIMIT 20;

-- Top receivers (lifetime, NET — matches users.received_total)
SELECT u.name,
       COALESCE(SUM(t.amount) FILTER (WHERE r.id IS NULL), 0) AS tacos_received
FROM transactions t
JOIN users u ON u.id = t.to_user_id
LEFT JOIN transactions r ON r.reversed_transaction_id = t.id
WHERE t.type = 'give'
GROUP BY u.name
ORDER BY tacos_received DESC
LIMIT 20;

-- Reversal volume (who's deleting / unreacting most)
SELECT u.name,
       COUNT(*) AS reversals,
       SUM(t.amount) AS tacos_undone,
       MAX(t.created_at) AS last_reversal_at
FROM transactions t
JOIN transactions g ON g.id = t.reversed_transaction_id
JOIN users u ON u.id = g.from_user_id
WHERE t.type = 'reversal'
GROUP BY u.name
ORDER BY reversals DESC
LIMIT 20;

-- Admin grants (signed adjustments, positive and negative)
SELECT t.created_at,
       a.name AS admin,
       u.name AS recipient,
       t.amount,
       t.reason
FROM transactions t
JOIN users u ON u.id = t.to_user_id
JOIN users a ON a.id = t.admin_user_id
WHERE t.type = 'grant'
ORDER BY t.created_at DESC
LIMIT 100;
```

### Monthly digest

```sql
-- Per-month volume (gross gives, plus reversal count)
SELECT date_trunc('month', t.created_at) AS month,
       COUNT(*) FILTER (WHERE t.type = 'give')      AS give_events,
       SUM(t.amount) FILTER (WHERE t.type = 'give') AS tacos_given,
       COUNT(*) FILTER (WHERE t.type = 'reversal')  AS reversals,
       COUNT(DISTINCT t.from_user_id) FILTER (WHERE t.type = 'give') AS unique_givers,
       COUNT(DISTINCT t.to_user_id)   FILTER (WHERE t.type = 'give') AS unique_receivers
FROM transactions t
GROUP BY 1 ORDER BY 1 DESC;

-- This month's leaderboard (NET — excludes reversed gives)
SELECT u.name, COALESCE(SUM(t.amount) FILTER (WHERE r.id IS NULL), 0) AS received
FROM transactions t
JOIN users u ON u.id = t.to_user_id
LEFT JOIN transactions r ON r.reversed_transaction_id = t.id
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
-- Gross gives per channel, with how many were later reversed
SELECT t.slack_channel_id,
       COUNT(*)                              AS gives,
       SUM(t.amount)                         AS tacos,
       COUNT(*) FILTER (WHERE r.id IS NOT NULL) AS reversed_gives
FROM transactions t
LEFT JOIN transactions r ON r.reversed_transaction_id = t.id
WHERE t.type = 'give'
GROUP BY t.slack_channel_id
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
-- For each user: SUM(gives received) − SUM(reversals against those gives) − SUM(redeems) + SUM(grants) should equal users.balance.
-- Grants are signed (`amount` may be negative), so we add them rather than subtract.
SELECT u.id, u.name, u.balance,
       COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'give'),     0)
       - COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'reversal'), 0)
       - COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'redeem'),   0)
       + COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'grant'),    0) AS computed_balance
FROM users u
LEFT JOIN transactions t ON t.to_user_id = u.id
GROUP BY u.id, u.name, u.balance
HAVING u.balance <>
       COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'give'),     0)
       - COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'reversal'), 0)
       - COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'redeem'),   0)
       + COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'grant'),    0);

-- Equivalent check for received_total: gives received − reversals received + grants.
SELECT u.id, u.name, u.received_total,
       COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'give'),     0)
       - COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'reversal'), 0)
       + COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'grant'),    0) AS computed_received
FROM users u
LEFT JOIN transactions t ON t.to_user_id = u.id
GROUP BY u.id, u.name, u.received_total
HAVING u.received_total <>
       COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'give'),     0)
       - COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'reversal'), 0)
       + COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'grant'),    0);
```

A row in either result means the audit log doesn't match the cached counter. The DB CHECK constraints (`balance <= received_total`, `daily_remaining >= 0`, the type-conditional amount rule, the four-way row-shape rule, and `reversed_transaction_id` UNIQUE) make this near-impossible, so a non-empty result is a strong signal of either a bug in the give/redeem/reversal/grant path or a manual SQL edit. Investigate before "fixing" the counter.

Note: `balance` and `received_total` are *allowed* to be negative — when a give is reversed after the recipient already redeemed against it, or when an admin issues a negative `grant`. That's not corruption; it's the correct accounting outcome and the reconciliation query will show `computed = users.*` in those cases.

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

### Onboarding a new user with a starter balance

To give a new hire (or any active user) a starter balance — typical pattern when seeding the bot for the first time, or when someone joins mid-quarter and you want them to participate immediately:

1. Sign in to `/admin/users` as an admin.
2. Find the user. (If they don't appear yet, run `pnpm sync-users` first or wait for `team_join` to fire.)
3. Use the **Adjust** form on their row: type a positive integer (e.g. `5`), add a reason like "onboarding starter pack", click **Adjust**, confirm the dialog.
4. Both `balance` and `received_total` go up by the amount; a `type='grant'` row is recorded with your admin ID; the user gets a DM from the bot.

Don't use this for ongoing daily participation — the daily-allowance + `:taco:` flow is what makes it visible recognition. Grants are administrative; they don't appear in the activity feed and they don't show up in give/receive analytics by default (only in the "Admin grants" audit query and in reconciliation).

### Manual balance correction

There is no "undo" UI by design; the audit log is append-only. Compensate with an *append* — never edit existing rows.

In order of preference:

- **Reverse the original give in Slack** (no admin intervention needed). If the issue is a recent give that shouldn't have happened — wrong recipient, posted as a joke, etc. — the giver can delete the message or remove the 🌮 reaction. The handler in `lib/slack/handlers/{message,reaction}.ts` writes a `type='reversal'` row, decrements the recipient's `balance`/`received_total`, restores the giver's `daily_remaining` (capped at the daily allowance), and DMs both parties. Idempotent and safe even under Slack retries.
- **Admin grant from `/admin/users`** (`adjustTacos` server action → `lib/admin/grant.ts`). Use a positive amount to credit, negative to claw back. Both `balance` and `received_total` move by the same delta so the `balance <= received_total` invariant holds. Always include a clear `reason` (it's logged on the `transactions` row and DM'd to the user). This is the right tool for "Q2 beta over-credited everyone, pull back N tacos per active user".
- **In-band give**, for forward correction with team visibility: have a workspace admin give the user the right number of `:taco:` reactions in `#taqueria`. Public, attributable, but consumes the admin's daily allowance.
- **Engineer-applied correction at the SQL layer**, only when the above three can't express what you need (e.g. a correcting `redeem` row tying back to a specific item): insert a single row via `pnpm db:studio` or a one-shot script, with a clear `reason`, and update the cached `users.balance` / `users.received_total` in the same transaction so CHECKs stay satisfied. Document the original transaction ID in the `reason` field so the audit trail is traversable later.

Never `UPDATE` or `DELETE` an existing `transactions` row — the schema's CHECK constraints and `reversed_transaction_id` UNIQUE assume rows are immutable, and downstream queries (reconciliation, monthly digests) read the entire history.

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
| User reports "I deleted my message but my taco count didn't drop" | Confirm the channel is in `TACO_CHANNELS` and the deletion event was actually delivered (Slack app dashboard → Event Subscriptions → Recent deliveries). The handler skips deletes outside the allowlist. If delivered, look for a `type='reversal'` row keyed `delete-<original-tx-id>`. |
| Bot doesn't add a confirmation reaction after a give | Expected by default: `TACO_REACT_ON_GIVE` defaults to `false` to avoid users mistaking the bot's reaction for an extra give. Gives still record correctly and the giver still gets a DM. Set `TACO_REACT_ON_GIVE=true` and redeploy if you want the visual ack. |
| Bot confirmation reaction is `:taco:` even though `TACO_ALT_EMOJI_NAME` is set (and `TACO_REACT_ON_GIVE=true`) | Most often the alt emoji doesn't exist in the workspace yet — `reactions.add` fails with `invalid_name` and we log `[reactions.add] failed`. Add the emoji in Slack → workspace settings → Customize → Emoji and the next give will react with it. Other causes: env var has colons (rejected at config read with a clear error), or the deploy that set the env var hasn't shipped yet. |
| Deploy startup throws `Invalid TACO_ALT_EMOJI_NAME` | The value contains characters outside `[a-z0-9_+-]` or includes `:`. Strip the colons (the value is a name, not the literal emoji) and avoid spaces or punctuation. |
| User says "I removed my reaction then re-added it but they didn't get the taco back" | Working as designed. The composite event ID (`react-${channel}-${ts}-${reactor}-${idx}`) is identical for the second reaction, so `onConflictDoNothing` no-ops. Tell them to give again from a different message. |
| `received_total` or `balance` is negative for a user | Usually correct: a give was reversed after the recipient already redeemed against it. Run the reconciliation query in this doc to confirm; if `computed = users.*` matches, leave it alone. |
