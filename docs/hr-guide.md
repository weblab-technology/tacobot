# Tacobot — HR / shop-admin guide

Onboarding for the HR person (or anyone in `ADMIN_SLACK_IDS`) who runs the Tacobot shop. This guide assumes you don't write code — there's nothing to install or configure on your side.

If you want to know how employees give and receive tacos, see `user-guide.md`. If you operate the deployment (env vars, deploys, channel allowlist), see the project `README.md`.

## Before you start

Your operator should already have:

- Added your Slack user ID to `ADMIN_SLACK_IDS` (so you can sign in to `/admin`).
- Set `HR_SLACK_ID` to your Slack user ID, and `HR_SLACK_HANDLE` to your `@handle` (without the `@`). This makes the shop page surface a clickable "DM HR" link to you. If those aren't set, the page just says "DM HR" with no link, and employees won't immediately know who to message.
- Redeployed after any of those env-var changes (changes don't take effect until redeploy).

If you can't sign in or the shop doesn't show your handle, ask your operator to confirm those env vars and redeploy.

## Signing in

1. Go to `https://<your-deploy-host>/admin`. (Your operator will tell you the URL — typically `tacobot.<your-domain>` or a `vercel.app` host.)
2. You'll be redirected to **Sign in with Slack**. Approve the OAuth prompt with the workspace account whose Slack ID is in `ADMIN_SLACK_IDS`.
3. After sign-in you land on `/admin` with links to **Activity**, **Leaderboard**, **Users**, and **Items**.

If sign-in bounces you straight back to the sign-in page, your Slack ID isn't on the allowlist. Confirm with your operator. (The system rejects non-admin sign-ins at the OAuth step on purpose — non-admins never get a session, so there's nothing for them to "explore" if they happen to land on `/admin`.)

## The admin screens

- `/admin/items` — manage the shop catalog (what employees can spend tacos on).
- `/admin/users` — see balances and process redemptions.
- `/admin/activity` — chronological feed of every give in the workspace, with reversal status, channel filter, and clickable links into Slack. Read-only; useful for context ("who gave what to whom recently?") and for spot-checking that the bot is behaving.
- `/admin/leaderboard` — ranked list of who's received, given, or combined the most tacos, filterable by period (today / this week / this month / all-time) and channel. Read-only; great for celebrating top contributors.

You can navigate between them via the header. **Sign out** is also in the header — use it on shared devices.

## Managing the shop catalog (`/admin/items`)

The page has two parts: an **Add item** form on top, and a list of every item below (active first, then inactive, sorted by most recently updated).

### Adding an item

Fill in:

- **Title** — what employees see in the shop. Required.
- **Redemption amount (tacos)** — the default cost in tacos. Must be a positive integer.
- **Quantity (optional)** — how many of these you have. Leave empty for unlimited. If set, must be a positive integer.
- **Description** — what the item is, in your words. Shown on the shop page.
- **Redemption instructions (optional)** — internal notes shown to admins on the redemption screen, not to employees. Useful for "DM kitchen Slack to schedule" or "$25 Amazon code, see HR vault".
- **Image** — either upload a file (saved to the project's image storage) or paste a URL. If you do both, the uploaded file wins. If you leave both empty when adding, the item shows without an image.

Click **Add item**. The page refreshes and the item appears in the list below. Open `/shop` in another tab to verify it's live (it can take up to 60 seconds to show because the shop page caches for a minute).

### Editing an item

Each item in the list has its own form pre-filled with the current values. Change anything, click **Save**.

Image-update behaviour:

- Upload a new file → replaces the previous image.
- Leave the file field empty but keep a URL in the URL field → uses that URL.
- Leave **both** image fields empty → keeps the existing image untouched.

If you want to actually clear an image, paste an empty URL or replace it with a 1×1 transparent placeholder; there's no explicit "remove image" button.

### Activating / deactivating an item

Each item has a **Deactivate** / **Reactivate** button below its form. Deactivated items disappear from `/shop` immediately but remain in the system — past redemptions still reference them, so the audit log stays correct.

Use **Deactivate** when:

- An item is out of stock and you want to hide it temporarily.
- You're retiring an item but don't want to lose the historical record of past redemptions.
- You set up an item in error.

You can reactivate at any time. Inactive items don't count toward the unique-name rule — so two deactivated items can share a name, but only one active item can have a given (case-insensitive) name.

### Naming and pricing tips

- Names are unique among **active** items (case-insensitive). If you want to "replace" an item, deactivate the old one first, then create the new one with the same name.
- Quantity is just a hint shown on the shop page ("3 available"). Tacobot doesn't actually decrement quantity when you redeem — that's your responsibility. If you give them out, edit the item and update the number, or deactivate it when sold out.
- Prices in tacos can be re-priced any time. Past redemptions keep the price they were redeemed at (it's stored on the `transactions` row).

## Processing a redemption (`/admin/users`)

The Users page shows every active employee, sorted by current balance (highest first, then alphabetical by name). Columns:

- **Name** — display name from Slack.
- **Received** — lifetime tacos received.
- **Balance** — currently redeemable.
- **Today left** — daily allowance remaining (informational; you don't usually care about this).
- **Redeem** — the form you use to deduct tacos.

### The flow

1. An employee DMs you saying "Can I redeem item X?" (the shop page nudges them to do this).
2. Find their row in the table (Cmd-F / Ctrl-F if the list is long).
3. In their **Redeem** form:
   - **Pick item**: dropdown listing all active items with their default prices.
   - **Amount**: the number of tacos to deduct. Defaults to whatever you type — it's not auto-filled from the item's price, so check the dropdown and type the matching number (or whatever you've negotiated).
   - **Note (optional)**: a free-text reason. Useful for context months later — e.g. "redeemed at all-hands 2026-Q2", "swag pickup", "donated $25 to charity X".
4. Click **Deduct**. The page reloads with the new balance.
5. Fulfill the item (gift card, swag, whatever). This part is on you — Tacobot doesn't do physical fulfillment.

### What the system enforces

- You can't deduct an amount the employee doesn't have. The database itself rejects it (CHECK `balance >= 0`), so even if your screen is stale and you click **Deduct** at the wrong moment, the system either succeeds (balance was enough) or returns an error ("Employee has insufficient balance for that amount") — there's no way to overdraw.
- You can't pick a non-existent item. The dropdown lists only active items.
- Amounts must be positive integers. The form rejects 0, negative, or non-numeric values.
- Every redemption is logged — your Slack ID, the employee's ID, the item, the amount, and any note — into the `transactions` audit log. There's no "anonymous" redemption.

### What the system doesn't enforce (you do)

- Whether the employee actually gets the thing they asked for. Tacobot deducts; you fulfill. Don't deduct until you've handed over the item, or use a clear note like "deducted, fulfillment pending — gift card to send Friday".
- Whether the price you're charging matches the item's "price_tacos". The default price is a guideline — you can deduct more or less if there's a reason.

## End-to-end picture (the mental model)

```
employee gives/receives 🌮  ───►  balance accumulates
                                       │
                                       ▼
       employee opens /shop, picks item, clicks "DM HR"
                                       │
                                       ▼
              employee DMs you with the item name
                                       │
                                       ▼
                you fulfill the item (physical step)
                                       │
                                       ▼
               you record the deduction in /admin/users
                                       │
                                       ▼
        balance drops; audit row stored for compliance
```

The order of "fulfill" vs. "deduct" is your call. Some HR teams deduct first (to lock the tacos) and fulfill later; some fulfill first (to be sure the redemption "took"). The audit log records the deduction time, not the fulfillment time, so use the **Note** field to disambiguate if needed.

## Browsing recent activity (`/admin/activity`)

A chronological list of every give event, newest first, grouped by day. For each event you see:

- The giver and recipient(s), as clickable Slack handles (open Slack DMs in one click).
- The channel where the give happened (`#channel-name`), also clickable.
- The amount per recipient and whether it was a typed message (with the message body shown) or a `:taco:` reaction (tagged "reaction").
- A reversal pill if the give was undone: ↺ **reversed** (struck through) for a fully reversed event, or ↺ **partially reversed (N/M)** for one where only some recipients lost their taco.

Use the **Filter** dropdown to scope the feed to one channel — handy when employees ask "did I really give Alice a taco in #marketing yesterday?". Click **Load older →** at the bottom to page back through history. The all-time total at the top is the lifetime gross sum (it does *not* subtract reversals; the per-row pills tell you which gives were undone).

This page is read-only. There are no buttons to deduct, refund, or edit anything from here — it's a lens, not a tool. To act on what you see, use `/admin/users` (redemption) or ask the employee to delete/unreact (reversal).

## Browsing the leaderboard (`/admin/leaderboard`)

A ranked table of who's sitting on top of the taco economy, with three filter dimensions:

- **Metric**: *Tacos received* (default), *Tacos given*, or *Tacos combined* (received + given).
- **Period**: *All-time* (default), *Today*, *This week*, or *This month*. Periods are computed in UTC; weeks are ISO weeks (Monday start) so they line up with the daily-reset boundary.
- **Channel**: *All channels* (default) or any single channel that's seen a give.

Filters auto-submit on change — pick a value and the page re-renders.

The table shows rank (sport-style: ties share a rank, the next rank skips by the size of the tie group), the user's name (clickable Slack handle), and total tacos for the chosen metric/period/channel. Inactive users are excluded; reversed gives are *not* counted.

Read-only. Use this for "who do we celebrate this month?" — pair it with a public shout-out in `#general`.

## Granting or clawing back tacos (`/admin/users` → Adjust)

Each row in `/admin/users` has an **Adjust** form alongside the Redeem form. Use it when you need to apply a *signed* change to someone's balance — positive to credit, negative to debit. The two intended use cases:

- **Onboarding starter pack**: a new hire gets +5 (or whatever you decide) so they can immediately participate in the shop.
- **Normalization / clawback**: roll back a balance that drifted during beta or got over-credited by a since-fixed bug.

How to use it:

1. Find the user in the table.
2. Type a signed integer in the **±N** field (e.g. `5` or `-3`). Zero is rejected.
3. Optional **Reason** — strongly recommended; this becomes part of the audit log.
4. Click **Adjust**. A browser confirm dialog appears summarising the change ("Apply +5 tacos to Alice? Reason: onboarding"). Negative amounts get an extra warning line. Confirm to apply.
5. Both the user's `balance` and `received_total` move by the same delta (so the leaderboard reflects the change). The user gets a DM from the bot announcing the adjustment and the reason.

What this is *not*:

- Not a redemption — there's no item, no shop credit moving the other way. Use the Redeem form for redemptions.
- Not a "give" — it doesn't consume your daily allowance, isn't tied to a Slack message, and doesn't appear in the activity feed.
- Not undoable in the UI. The audit log is append-only. If you applied the wrong sign, immediately apply a compensating adjustment (e.g. you applied `+5` by mistake, follow with `-5` and a reason like "compensating mistaken +5 above").

Use sparingly. Every grant is logged with your Slack ID, the recipient, the amount, and the reason — and unlike gives or redeems, there's no other system check on the magnitude. The confirm dialog is the only guard against typos, so read it before clicking.

## Common HR tasks

### Item is out of stock

- **No quantity set, indefinite restock**: deactivate the item (`Deactivate` button below its form). It vanishes from `/shop`. Reactivate when restocked.
- **Quantity set**: edit the item, set quantity to 0, save. The shop page still shows the item but with "0 available" so employees know what's coming back. (Yes, the system technically lets you redeem against 0 quantity — quantity is informational. Use deactivation if you need a hard stop.)

### A give was a mistake (employee asks)

Employees can fix this themselves — you usually don't need to do anything. They have two options:

- Remove the 🌮 reaction, or
- Delete the Slack message that gave the taco(s).

Either action reverses the give automatically: the recipient's balance drops, the giver's daily allowance is restored (capped), and both parties get a DM. The audit log records a `type='reversal'` row pointing at the original give. If an employee asks you to "undo a give", first check whether they can do it themselves with one of the above.

### A redemption was a mistake

Redemptions are *not* automatically reversible — there's no "undo" button by design and the audit log is append-only.

If the mistake was small (wrong amount), do a compensating action:

- Have a workspace admin give the employee 🌮 reactions in `#taqueria` to top them back up (visible to the team).
- Or, ask an engineer to issue a manual correcting `transactions` row — they know how. Always document it in the original redemption's note retroactively if possible, and in the new row's reason ("correction for tx <id> — wrong amount entered").

If the redemption was for the wrong item, edit the original `transactions` row's reason to flag it ("originally entered as Item A, actually Item B — see corrected entry tx <id>") and create a corrective entry. The audit-log philosophy is: never lie about the past, even if it was wrong.

### Reporting / analytics

`docs/operations.md` has a SQL cookbook (monthly digest, item popularity, reconciliation queries). You can ask an engineer to run any of those against the live database (`pnpm db:studio`) and screenshot the results, or set up a recurring digest if the workspace cares.

## What you can't do (boundaries)

| You can do | You can't do |
| --- | --- |
| Manage all items (add, edit, deactivate) | Change which channels Tacobot listens in (operator) |
| Process redemptions for any active employee | Change the daily allowance (operator) |
| See every active user's balance and lifetime received | Add or remove other admins (operator) |
| Add a note to a redemption | Undo a redemption directly (engineer support) |
| Sign yourself out | Reset someone's daily allowance manually (operator triggers cron) |

When in doubt, ask the operator (env-var changes, who-can-sign-in) or an engineer (database edits, custom corrections).

## Security hygiene

- **Sign out** when you're done on a shared device. The header has the button.
- Don't share screenshots that include other employees' balances — they're internal data.
- If you suspect your Slack account has been compromised, tell your operator immediately so they can pull your ID from `ADMIN_SLACK_IDS` and revoke the session.
- Keep redemption notes professional. They're permanent.
