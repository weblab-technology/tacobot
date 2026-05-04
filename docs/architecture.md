# Architecture

How Tacobot is put together. Audience: engineers extending the codebase, on-call responders trying to understand failure modes, future-you in 12 months. For an end-user view, see `user-guide.md`. For HR-admin, see `hr-guide.md`.

## System overview

```
                          Slack workspace
                                │
             ┌──────────────────┼──────────────────┐
             │                  │                  │
   reaction_added          message              app_mention
   ( :taco: )            ( :taco: )           ( DM / mention )
             │                  │                  │
             └────────► /api/slack/events ◄────────┘
                              │  HTTPS POST
                              ▼
                    AppRouterReceiver  (lib/slack/receiver.ts)
                       1. read raw body
                       2. HMAC-SHA256 verify (5-min replay window)
                       3. URL-verification short-circuit
                       4. JSON parse, hand to Bolt App
                              │
                              ▼
                       @slack/bolt  App  (processBeforeResponse: true)
                              │
        ┌─────────────────────┼─────────────────────────┐
        ▼                     ▼                         ▼
  message handler       reaction handler          command handler
  (lib/slack/            (lib/slack/                (lib/slack/
   handlers/              handlers/                  handlers/
   message.ts)            reaction.ts)               commands.ts)
        │                     │                         │
        └────────► validate / decide ────────┐          │
                       (lib/slack/give.ts)   │          │
                                             ▼          │
                                       executeGive      │
                                  (lib/slack/execute.ts)│
                                             │          │
                                             ▼          ▼
                                          Drizzle ORM (lib/db/)
                                             │
                                             ▼
                                        Vercel Postgres


       Slack OIDC ─────► /api/auth/* ─────► Auth.js v5 ─────► /admin/*
                         (Auth.js)            (lib/auth.ts)    (admin allowlist)

       Vercel Cron ─────► /api/cron/reset-allowance ──► UPDATE users
       (0 0 * * *)        (Bearer ${CRON_SECRET})
```

## Layered architecture

| Layer | Lives in | Responsibility |
| --- | --- | --- |
| HTTP boundary | `app/` | Next.js routes (landing, shop, admin items/users/activity), server actions, Slack webhook entry, cron entry, Auth.js handlers. Thin — delegates immediately. |
| Slack domain | `lib/slack/` | Bolt setup, custom receiver, event handlers, parser, give validation/decision/execution, format helpers, user-info cache. |
| Persistence | `lib/db/` | Drizzle schema, query helpers, structural type for the DB client. |
| Privileged ops | `lib/admin/` | Redemption (admin-initiated balance deduction). |
| Cross-cutting | `lib/config.ts`, `lib/auth.ts` | Env-var access; auth + admin allowlist. |

## Data model

Three tables in `lib/db/schema.ts`. Constraints are enforced at the database layer so a buggy handler (or raw SQL session) can't corrupt the state.

### `users`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | Slack user ID (`U…`). Same key Slack uses; we never mint our own. |
| `name` | text NN | Display name. Cached from `users.info`; refreshed lazily by `userInfo.ts`. |
| `daily_remaining` | int NN | Tacos left to give today. Reset to `TACO_DAILY_ALLOWANCE` at 00:00 UTC. |
| `received_total` | int NN, default 0 | Lifetime tacos received. |
| `balance` | int NN, default 0 | Currently redeemable. Goes down on `redeem`; goes up by `amount` on every received `give`. |
| `is_active` | bool, default true | Flipped by `user_change` (deleted) or `sync-users` (member missing from `users.list`). |
| `created_at` / `updated_at` | timestamptz | |

CHECK constraints:

- `daily_remaining >= 0`
- `balance <= received_total`

`balance` and `received_total` may go *negative* after a reversal of a give whose recipient already redeemed: the give that funded the redemption is undone, but the redemption itself stays. Both columns are decremented together by the reversal, so the `balance <= received_total` relationship is preserved. The redeem flow's `WHERE balance >= amount` (in `lib/admin/redeem.ts`) is what prevents *spending* into the negative; only reversals can push the counters below zero.

The remaining `balance <= received_total` invariant is load-bearing: a user can never spend more than they have on hand. Combined with the redeem flow's `WHERE balance >= amount`, you cannot overdraw even with concurrent admin requests.

### `items`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `name` | text NN | |
| `description` | text | |
| `image_url` | text | Either Vercel Blob URL or operator-pasted URL. |
| `price_tacos` | int NN | Default redemption amount. CHECK > 0. |
| `quantity` | int | Optional. Null = unlimited. CHECK `> 0 OR NULL`. |
| `redemption_instructions` | text | Free text shown to admins on redemption (e.g. "DM kitchen Slack"). |
| `is_active` | bool, default true | Soft-delete flag. Inactive items disappear from `/shop` but stay referenced from old `transactions` rows. |
| `created_at` / `updated_at` | timestamptz | |

Plus a partial unique index: `lower(name)` is unique among `is_active = true`. Two inactive items can share a name; the live catalog can't.

### `transactions`

The append-only audit log. Every `give`, every `redeem`, and every `reversal` adds rows here. Reversals compensate gives via a foreign key on `reversed_transaction_id` — we never UPDATE or DELETE existing rows.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `type` | text NN | `'give'`, `'redeem'`, or `'reversal'`. |
| `to_user_id` | text NN, FK → users | Always set. For `reversal`, this is the original recipient (whose counters are decremented). |
| `from_user_id` | text, FK → users | Set for `give`, NULL for `redeem` and `reversal`. |
| `admin_user_id` | text, FK → users | Set for `redeem`, NULL for `give` and `reversal`. |
| `item_id` | uuid, FK → items | Set for `redeem`, NULL for `give` and `reversal`. |
| `amount` | int NN | CHECK > 0. For `reversal`, mirrors the original give's amount. |
| `reason` | text | Free text — message body for gives, admin note for redeems, `'message_deleted'` / `'reaction_removed'` for reversals. |
| `slack_event_id` | text UNIQUE | Idempotency key (see below). |
| `slack_channel_id` | text | Where the give happened (NULL for redeems). Mirrored on reversals. |
| `slack_message_ts` | text | The message Slack timestamp (NULL for redeems). Mirrored on reversals. |
| `reversed_transaction_id` | uuid UNIQUE | Set for `reversal` only — points at the give being compensated. UNIQUE so any single give can be reversed at most once. |
| `created_at` | timestamptz | |

Three composite checks make the row shape watertight:

```sql
CHECK (
  (type = 'give'     AND from_user_id IS NOT NULL
                     AND admin_user_id IS NULL
                     AND item_id IS NULL
                     AND reversed_transaction_id IS NULL
                     AND from_user_id <> to_user_id)
  OR
  (type = 'redeem'   AND from_user_id IS NULL
                     AND admin_user_id IS NOT NULL
                     AND item_id IS NOT NULL
                     AND reversed_transaction_id IS NULL)
  OR
  (type = 'reversal' AND from_user_id IS NULL
                     AND admin_user_id IS NULL
                     AND item_id IS NULL
                     AND reversed_transaction_id IS NOT NULL)
)
CHECK (amount > 0)
```

Indexes: `(to_user_id, created_at)`, `(from_user_id, created_at)`, `(type, created_at)`, `(admin_user_id, created_at)`, `(slack_channel_id, slack_message_ts)` — the last one supports the reversal lookup on `message_deleted` events.

#### Why one row per taco

A "give 3 tacos to Alice" produces three `transactions` rows, not one row with `amount=3`. Each row gets its own `slack_event_id` (`${envelopeEventId}-${idx}`). This keeps the audit log uniform with single-taco reactions and makes per-taco analytics trivial (`SELECT count(*) FROM transactions WHERE type='give'` is "tacos given", not "give events"). Multi-recipient gives split the same way.

## Give flow trace

What happens when someone posts `<@alice> :taco: :taco:` in `#taqueria`:

1. Slack POSTs the event to `/api/slack/events`.
2. `AppRouterReceiver.handle()`:
   - `req.text()` reads raw body.
   - `verify()` checks `x-slack-request-timestamp` is within 5 minutes and `x-slack-signature` matches HMAC-SHA256(`v0:${ts}:${body}`, signing_secret), timing-safe compared.
   - JSON-parses body. If `type === "url_verification"`, returns `{ challenge }`. Otherwise builds a `ReceiverEvent` and calls `app.processEvent`.
3. Bolt dispatches to the `message` handler in `lib/slack/handlers/message.ts`:
   - Skips edits/deletes/bot messages and non-channel events.
   - `countTacos(text, config.taco.acceptedEmojis)` builds a regex over the active emoji set (always `:taco:`, plus the alt emoji from `TACO_ALT_EMOJI_NAME` if set). `findUserIds(text)` (regex `<@(U…)>` with optional `|name`).
   - Filters out the bot's own user ID (resolved once via `getBotUserId()`).
   - Verifies channel is in `config.taco.channels`.
   - Lazy-upserts giver and recipients (placeholder `name = id`); kicks off `resolveUserName()` for each, then `upsertUser` again with the resolved name (the lazy upsert never overwrites a real name with the raw ID).
   - Loads giver row, calls `validate(intent, giver, config)`:
     - Channel allowlisted? Active? `tacoCount > 0`?
     - Dedup recipients (`new Set`), strip self-gives.
     - `totalDemand = tacoCount × recipients.length`. If > `dailyRemaining`, returns `over_allowance`.
     - Otherwise returns `ok` with `recipients`, `totalDemand`, `perRecipient = tacoCount`.
   - On `ignore` → silent. On `over_allowance` → ephemeral message with `overAllowanceMessage(demand, remaining)`.
   - On `ok` → `decide()` builds a `GivePlan` with one `PlannedTransaction` per recipient, each with `slackEventId = ${envelopeEventId}-${idx}`.
   - `executeGive(db, plan)`:
     - Opens a DB transaction.
     - `UPDATE users SET daily_remaining = daily_remaining - giverDecrement, updated_at = now() WHERE id = giverId AND daily_remaining >= giverDecrement RETURNING id`. If 0 rows, returns `over_allowance` (the transaction will roll back as the callback returns).
     - For each planned transaction:
       - `UPDATE users SET received_total = received_total + amount, balance = balance + amount` for the recipient.
       - `INSERT INTO transactions (…) ON CONFLICT (slack_event_id) DO NOTHING RETURNING id`. If the insert returns 0 rows, throw `DuplicateGiveError` (caught outside the transaction, returns `duplicate`).
   - On `ok`: best-effort `reactions.add({ name: "taco" })`, then DM the giver a summary, then DM each recipient. Failures here are logged and swallowed — the database is the source of truth.

## Reaction flow trace

Reactions are simpler: 1 taco per reaction.

1. Slack POSTs `reaction_added`. Receiver verifies as above.
2. `lib/slack/handlers/reaction.ts:registerReactionHandler`:
   - Filters: emoji must be in `config.taco.acceptedEmojis` (always `taco`, plus the alt emoji if `TACO_ALT_EMOJI_NAME` is set), item must be `message`, channel must be allowlisted.
   - The payload doesn't include the message author, so we call `conversations.history` for that single message (`limit: 1`, `inclusive: true`). Failure → log + return.
   - Calls `processReaction(db, { reactor, author, channelId, messageTs })`. This is the testable core.
3. `processReaction`:
   - Skip if author is the bot or the reactor (no self-gives, no rewarding the bot).
   - Lazy-upsert + name-resolve both users (parallel `Promise.all`).
   - `validate()` with `tacoCount: 1` and `slackEventId = react-${channelId}-${messageTs}-${reactor}` (the composite stops the same person re-reacting, removing, and re-reacting from being counted twice — Slack treats remove+re-add as new events, but this composite ID is identical, so the `ON CONFLICT` catches it).
   - `decide()` then `executeGive()`.
   - Returns `{ kind: "ok"|"ignore"|"over_allowance" }`.
4. Outer handler turns the outcome into Slack side-effects: ephemeral over-allowance message, DM giver, DM recipient.

## Redeem flow trace

Initiated by an admin in `/admin/users`.

1. The admin picks an item, sets the amount (defaults to `priceTacos`), optionally types a reason, clicks **Deduct**.
2. The form posts to the `deductTacos` server action (`app/admin/users/actions.ts`).
3. `requireAdminId()` calls `auth()` and pulls `slackUserId` from the session. No session → throw.
4. `redeem(db, { employeeId, itemId, amount, adminId, reason })`:
   - Transaction.
   - `UPDATE users SET balance = balance - amount, updated_at = now() WHERE id = employeeId AND balance >= amount RETURNING id`. If 0 rows → `{ kind: "insufficient" }` (transaction rolls back as the callback returns).
   - `INSERT INTO transactions (type='redeem', to_user_id=employeeId, admin_user_id=adminId, item_id=itemId, amount, reason)`. The CHECK constraints enforce row shape.
5. `revalidatePath("/admin/users")` so the table re-fetches.

There is no "undo redemption" UI by design — the audit log is append-only. To compensate, give the user a `give` from a workspace admin's Slack account or have an engineer issue a correcting `redeem` row with a clear `reason`.

## Reversal flow trace

Gives — but not redemptions — are reversible:

- **`message_deleted`** (`lib/slack/handlers/message.ts`): the original Slack message that produced gives is gone. We look up every `type='give'` transaction with matching `(slack_channel_id, slack_message_ts)` (catches both text-mention gives and `:taco:` reactions left on the message) and call `executeMessageReversal` (`lib/slack/reverse.ts`).
- **`reaction_removed`** (`lib/slack/handlers/reaction.ts`): the reactor took back their `:taco:` reaction. We look up `type='give'` rows matching `(slack_channel_id, slack_message_ts, from_user_id=reactor)` and call `executeReactionReversal`.

Both functions follow the same pattern, mirroring `executeGive`:

1. Open a DB transaction.
2. SELECT the candidate gives.
3. For each give, INSERT a `type='reversal'` row with `reversed_transaction_id = give.id` and `slack_event_id = '<delete|unreact>-<give.id>'`. The UNIQUE on `reversed_transaction_id` is the primary idempotency lever — `onConflictDoNothing` makes a Slack retry a no-op for that specific give.
4. Only when the INSERT returns a row (i.e. the reversal is new) do we update counters:
   - Recipient: `balance -= amount, received_total -= amount` (allowed to go negative when the recipient already redeemed).
   - Giver: `daily_remaining = LEAST(daily_remaining + amount, daily_allowance)`. The cap handles cross-midnight reversals where the cron has already topped the giver up — we never push past the daily allowance.

The handlers DM the actor and the affected recipients on success. A noop (no rows matched, or every match was already reversed) is silent.

`receivedTotal` and `balance` may end up negative after a reversal-of-an-already-redeemed give, by design (see the user-table CHECK note above).

## Idempotency model

Slack will retry events that don't ack within 3 seconds, and operators sometimes replay events from the dashboard during debugging. Our defence is a single unique key per logical taco:

- Message gives: `${event.event_ts}-${idx}` for the i-th recipient.
- Reaction gives: `react-${channel}-${messageTs}-${reactor}-${idx}` (the `-${idx}` suffix supports reactions on multi-mention messages).
- Reversals: `delete-${original.id}` for `message_deleted`, `unreact-${original.id}` for `reaction_removed`. The UNIQUE on `reversed_transaction_id` is the primary lever; this column-level UNIQUE is just for traceability and a safety belt.

The `transactions.slack_event_id` UNIQUE constraint plus `onConflictDoNothing` makes the insert a no-op on retry. For gives, the `WHERE inserted.length === 0` check inside the transaction throws `DuplicateGiveError` so the *whole give* rolls back — including the giver's `daily_remaining` decrement. Without that rollback, a retry would double-debit the giver. Reversals use a per-row pattern: each give is reversed independently, and a duplicate `INSERT` on `reversed_transaction_id` skips the counter updates for that specific row while still committing other progress in the same batch.

The flow is convergent: the same event delivered N times produces the same final database state.

## Concurrency model

Two scenarios:

- **Concurrent gives from the same user** (e.g., they post two messages a millisecond apart): each transaction's `WHERE daily_remaining >= N` is the gate. Postgres serializes the row-level update — only one transaction can hold the row's xmax at a time, and the second transaction sees the post-first-decrement value. The over-allowance one returns 0 rows from the UPDATE and rolls back.
- **Concurrent admin redemptions for the same employee**: same pattern on `balance`. The atomic `WHERE balance >= amount` is the gate; a `balance >= 0` CHECK is *not* present (reversals can push it negative), so the WHERE clause carries the full weight.

We don't need advisory locks or read-modify-write retry loops because the UPDATE-with-WHERE atomically captures the read. This is the single most important reason every state mutation goes through `executeGive` / `redeem` rather than ad-hoc Drizzle calls in handlers.

## User-sync model

We need the `users` table to roughly track Slack workspace membership.

- **Bootstrap**: `pnpm sync-users` (`scripts/sync-users.ts`) calls `users.list` (paginated, 200/page), upserts each non-bot, non-deleted member, and flips `is_active = false` for any user not seen in this run. Run this once after first deploy and any time you've had a large org change.
- **`team_join`** (`lib/slack/handlers/userSync.ts`): a new member appears → upsert with their resolved display name.
- **`user_change`**: profile change or deletion. Deleted users get `is_active = false`. Otherwise we refresh `name`.
- **Lazy upsert on first mention** (`ensureUserExists` in `lib/db/queries.ts`): if someone gives a taco to a user we haven't seen yet (e.g. the user joined while `team_join` was throttled), the message handler creates the row with placeholder `name = id`, then `resolveUserName` fills it in.

`name` accuracy matters less than you'd think: the score command renders `<@USERID>` mentions, which Slack expands to the live display name + avatar. Our `name` column is mostly for the admin tables and audit log.

## Auth and admin gate

`lib/auth.ts` configures Auth.js v5 with the Slack provider:

- `signIn` callback pulls the Slack user ID from `profile["https://slack.com/user_id"]` (Slack's workspace-scoped claim) or falls back to `profile.sub`. If it's not in `config.admin.slackIds`, return `false` — Auth.js refuses the sign-in and never creates a session.
- `jwt` stashes `slackUserId` on the token.
- `session` exposes `slackUserId` to consumers.

`app/admin/layout.tsx` calls `auth()` and `redirect("/api/auth/signin?callbackUrl=/admin")` if there's no session. That's a UX redirect, not the actual gate — the gate is in `signIn`.

Server actions (`deductTacos`, `createItem`, `updateItem`, `toggleItemActive`) re-check `auth()` at execution time and throw `unauthorized` on no-session. Don't trust the layout to keep mutations safe; defence in depth.

## Cron and timezone

`vercel.json` declares one cron:

```json
{ "path": "/api/cron/reset-allowance", "schedule": "0 0 * * *" }
```

Vercel cron expressions are UTC and **don't interpolate env vars**. Changing the timezone is a file edit and redeploy.

The route accepts both POST and GET (Vercel sends GET in some configurations). Both verify `Authorization: Bearer ${CRON_SECRET}` — the `CRON_SECRET` env var is auto-managed on Vercel. The route then calls `resetDailyAllowance(db, dailyAllowance)` which `UPDATE users SET daily_remaining = $1, updated_at = now() WHERE is_active = true`.

Inactive users keep their old `daily_remaining` (they can't post anyway) so the table stays a snapshot of the last time each user was active.

## Related references

- `bolt-app-router-notes.md` — the exact Bolt 4.x receiver contract and Auth.js v5 OIDC claims, captured at design time.
- `slack-setup.md` — the Slack-app provisioning checklist.
- `operations.md` — audit queries, smoke checklist, runbooks for ops events.
- `development.md` — devcontainer, local Slack delivery, testing patterns.
