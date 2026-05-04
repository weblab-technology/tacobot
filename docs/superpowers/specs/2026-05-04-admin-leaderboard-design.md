# Admin Leaderboard Page — Design

**Date:** 2026-05-04
**Status:** Approved (pending implementation plan)

## Goal

Add a new `/admin/leaderboard` page to the admin panel showing users ranked by tacos, with three filters: metric (received / given / combined), period (all-time / today / this week / this month), and channel scope.

The original request also mentioned a "balance" page; that was dropped after we confirmed `/admin/users` already shows per-user balances.

## User-visible behaviour

- New entry "Leaderboard" in the admin top-nav (between Activity and Users) and in the bullet list on `/admin`.
- Page title: **Leaderboard**.
- Three filter dropdowns (right side, GET form):
  - **Metric** — Tacos received (default) / Tacos given / Tacos combined.
  - **Period** — All-time (default) / Today / This week / This month.
  - **Channel** — All channels (default) / one specific channel that has give-history.
- Table columns: **Rank · Person · Total Tacos**.
  - Rank uses sport-ranking (1, 2, 2, 4) on ties.
  - Person uses the existing `UserMention` style (Slack-link, current display name, avatar initials).
  - Total Tacos shown with 🌮 prefix.
- Empty state: "No tacos in this period." (or "...in this channel" / generic, depending on filters).
- Inactive (`is_active = false`) users are excluded even with historical activity, matching `/admin/users` convention.

## Architecture

Single transactions-derived query handles all filter combinations. No materialized tables, no hybrid counter/transactions code paths. Reasoning: at workspace scale, transactions table is small, all required indexes already exist, page is admin-only and on-demand. One source of truth keeps semantics aligned across views.

### Files

| File | Action | Purpose |
| --- | --- | --- |
| `app/admin/leaderboard/page.tsx` | new | Server component: parses search params, calls query, renders filters + table. Mirrors `/admin/activity` shape. |
| `lib/db/queries.ts` | edit | Add `getLeaderboard({ metric, since, channel })`. |
| `lib/date.ts` | edit | Add `periodStart(period, now): Date \| null`. |
| `app/admin/layout.tsx` | edit | Add nav link. |
| `app/admin/page.tsx` | edit | Add bullet-list link. |
| `tests/unit/period-start.test.ts` | new | Unit test for boundary logic. |
| `tests/integration/leaderboard.test.ts` | new | Integration test for the query. |

The duplicated `displayName` / `UserMention` / `Avatar` / channel-mention helpers between activity and leaderboard are not extracted in this spec — three similar usages don't yet justify a shared module. If a third page ever needs them, extract then.

## Filter semantics

URL params (parsed in the server component, invalid values fall back to defaults silently):

```
metric  = received | given | combined        (default: received)
period  = all | today | week | month         (default: all)
channel = <slack_channel_id>                 (default: unset = all channels)
```

### Period boundaries

All boundaries are computed in **UTC**. Daily allowance reset is already UTC-based, so the leaderboard's "Today" stays consistent with the bot's day.

| Period | Lower bound (`>=`) | Upper bound |
| --- | --- | --- |
| `all` | none | none |
| `today` | today 00:00 UTC | none |
| `week` | most recent Monday 00:00 UTC (ISO week) | none |
| `month` | first of current month 00:00 UTC | none |

`periodStart(period, now)` returns the lower bound or `null` for `all`. Only a lower bound is needed — no period queries the future.

### Reversal semantics — "net by give-date"

A reversal subtracts from the period that contains its **original give**, not the period the reversal happened in. Past weeks/months remain stable: a reversal of a give from last week pulls last week's tally down even now. This matches the conceptual model of `users.receivedTotal` (which already nets across all-time).

### Channel filter

Filters `transactions.slack_channel_id` on the **give** row (not the reversal). Applies to received, given, and combined metrics identically. The channel options dropdown is global (all channels that ever had a give) rather than period-scoped, matching `/admin/activity`.

## Query

Single Drizzle function, `getLeaderboard({ metric, since, channel })`, returning `{ userId: string; total: number }[]` ordered `total DESC, userId ASC`.

### Received

```sql
SELECT g.to_user_id AS user_id,
       SUM(g.amount) - COALESCE(SUM(r.amount), 0) AS total
FROM transactions g
LEFT JOIN transactions r
  ON r.reversed_transaction_id = g.id AND r.type = 'reversal'
INNER JOIN users u ON u.id = g.to_user_id AND u.is_active
WHERE g.type = 'give'
  [AND g.created_at >= :since]
  [AND g.slack_channel_id = :channel]
GROUP BY g.to_user_id
HAVING SUM(g.amount) - COALESCE(SUM(r.amount), 0) > 0
ORDER BY total DESC, user_id ASC;
```

### Given

Same shape, `GROUP BY g.from_user_id`, `INNER JOIN users u ON u.id = g.from_user_id AND u.is_active`.

### Combined

`UNION ALL` the two subqueries (each already net-of-reversals), then group by user_id and sum:

```sql
SELECT user_id, SUM(total) AS total
FROM (
  <received subquery>
  UNION ALL
  <given subquery>
) x
GROUP BY user_id
HAVING SUM(total) > 0
ORDER BY total DESC, user_id ASC;
```

### Indexes used

Existing indexes are sufficient:
- `transactions_type_created` — covers `type='give' AND created_at >= :since`.
- `transactions_to_created`, `transactions_from_created` — cover the GROUP BY columns.
- `transactions_channel_message` — covers the channel filter.
- `users(id)` PK + `is_active` selectivity — fast inner join.
- `transactions(reversed_transaction_id)` UNIQUE — fast left join for reversals.

### Ranking with ties

Computed in JS after the query (one pass, trivial). Sport-ranking: same totals share rank, the next rank skips by group size — `[10, 7, 7, 3]` ranks as `1, 2, 2, 4`.

## Rendering

- Layout mirrors `/admin/activity`: `<h1>Leaderboard</h1>`, filter form, table, empty state.
- Filter dropdowns submit a GET form; URL stays bookmark-friendly and back/forward works.
- Person column reuses the activity-page pattern: `Avatar` + `UserMention` (Slack deep-link, name from `users.name`, fallback to Slack name resolution for any rare gap).
- Names: query active users in one batch; for any id missing or still equal to its raw Slack id, fall back to `resolveUserName` (1h cache, in-flight dedup) — same approach as activity.
- Channel labels: same as activity — fetch distinct channel ids from `transactions`, resolve via `resolveChannelName`.

## Edge cases

- **No transactions at all** / no rows in window: empty state.
- **Slack name resolution fails for a user**: render the raw Slack id as fallback (already how `displayName` behaves).
- **All users on leaderboard inactive**: empty state (filtered out by inner join).
- **Reversal pointing to a give outside the period**: not counted (correct: the give was not in the period to begin with).
- **A give made by a now-inactive user, received by an active user**: counted toward receiver's "received" and "combined" totals; not surfaced as a giver row.
- **Combined metric, user appears only as giver**: still ranked.

## Testing

### Unit — `tests/unit/period-start.test.ts`

- `periodStart('all', _)` → `null`.
- `periodStart('today', date)` → that date 00:00 UTC.
- `periodStart('week', monday)` → the same Monday 00:00 UTC.
- `periodStart('week', sunday)` → the *previous* Monday (week rolls over Mon→Sun).
- `periodStart('month', any_date)` → first of that month 00:00 UTC.

### Integration — `tests/integration/leaderboard.test.ts` (PGlite, `inRollbackTx`)

1. **Received ranks correctly** — three users with different received totals come back in descending order.
2. **Reversal subtracts from received** — including the case where the reversal row's `created_at` is outside the period but the original give is inside (net-by-give-date semantics).
3. **Given ranks by giver** — same shape, also net-of-reversals.
4. **Combined sums received + given** — a user who is only a giver still appears.
5. **`period='today'`** — a give from yesterday (UTC) is excluded; a give from today is included.
6. **Channel filter** — a give in another channel is excluded; same user in the filtered channel still ranks.
7. **Inactive user excluded** — a give received by an `is_active=false` user does not appear.
8. **Tie-break deterministic** — equal totals order by `user_id ASC`.

## Out of scope

- Per-user detail page / drill-down. (Was discussed as "Option A" for the dropped balance feature; not added now.)
- Year-period filter, custom date range.
- Pagination / "load more". Single scrollable page is fine for typical workspace sizes (asked and confirmed during brainstorm).
- A separate balances page beyond what `/admin/users` already shows.
- Any change to existing `/admin/users` redemption flow.

## Risks & non-issues

- **Performance**: query is `O(active gives in window)`, GROUP BY hits indexed columns, page is admin-only and on-demand. Not a concern at workspace scale.
- **Stale week boundary across midnight**: page is `dynamic = "force-dynamic"`, recomputes on each request. Boundary moves naturally.
- **DST / timezones**: deliberately none — all UTC, matching daily-reset semantics. Operators in different timezones see the same ranking the bot sees.
