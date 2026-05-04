# Tacobot — employee guide

A short walkthrough of how to use Tacobot day-to-day. If you're an HR admin, see `hr-guide.md`. If you operate the deployment, see the project `README.md`.

## What it is

Tacobot is a thank-you economy in Slack. When a teammate does something nice, helpful, or impressive, you give them a 🌮. Tacos accumulate as a balance you can spend in the shop on items HR has set up — gift cards, snacks, swag, time-off, whatever the workspace has agreed on.

Tacos are **non-monetary recognition**. They have no payroll value, they don't carry over outside the bot, and they're tracked entirely inside this workspace.

## Where you can give

Inside any channel listed in your workspace's `TACO_CHANNELS` allowlist — typically a single shared channel like `#taqueria`. The bot must be a member of the channel for it to notice anything (your operator handles that).

DMs to the bot don't count as gives — DMs are for commands (`balance`, `score`, etc.); see below.

## How to give

Two ways. Both work; pick whichever fits the moment.

### React with 🌮

Hover over a teammate's message → click **Add reaction** → pick `:taco:`. That's one taco for them, debited from your daily allowance.

If you change your mind, remove the reaction. The give is reversed: the recipient's balance drops back, your daily allowance is restored (capped at the daily limit), and both of you get a DM. **Caveat:** if you remove and then re-add the same reaction on the same message, the second reaction is silently ignored (it has the same internal ID as the first, which has now been reversed). To give them a taco again, give from a different message.

### Type a give

In an allowlisted channel:

```
@alice :taco:                       → 1 taco to Alice
@alice :taco: :taco: :taco:         → 3 tacos to Alice
@alice @bob :taco: :taco:           → 2 tacos each to Alice and Bob (4 total)
```

The count of `:taco:` in the message is the number of tacos *each* recipient gets. You'll get a DM from the bot confirming the give and showing your remaining daily allowance — that's the source of truth. (Some workspaces also enable a 🌮 reaction from the bot on your message as a visual ack; it's off by default to avoid being mistaken for an extra give.) If the message couldn't be processed (over allowance, no recipient, channel not allowlisted), the bot either says nothing or sends you an ephemeral note only you can see.

### Custom currency emoji

Some workspaces also accept a branded custom emoji (e.g. `:wltaco:`) alongside `:taco:`. If your operator set `TACO_ALT_EMOJI_NAME`, you can react with — or type — that emoji and it counts the same. If the bot's confirmation reaction is enabled in your workspace, it will use the custom emoji in that case. If you're not sure what's enabled here, ask your operator or just use `:taco:` (always works).

What's filtered out:

- Self-gives (`@you :taco:`) — silently ignored.
- The bot itself as a recipient (`@tacobot :taco:`) — silently ignored.
- Any duplicate of the same recipient in one message — collapsed.

## Limits

You get a daily allowance — by default **5 tacos to give per day**. The exact number is set by your operator (`TACO_DAILY_ALLOWANCE`).

The allowance resets at **00:00 UTC** every day. If you want to know what time that is locally, ask your operator (the timezone is fixed in the deploy config).

Going over your allowance gets you an ephemeral message ("you tried to give 4 tacos but you only have 2 left today") — no taco is sent and nothing changes in the database.

## DM commands

DM `@tacobot` directly. The bot understands a few keywords (English and French aliases):

| Command | Effect |
| --- | --- |
| `score` / `ranking` / `leaderboard` | Top 5 lifetime taco receivers in the workspace. |
| `balance` / `wallet` | How many tacos you currently have to spend, plus the shop URL. |
| `left` / `how many` / `how much` / `combien` | How many tacos you have left to give today. |
| `shop` / `boutique` | The shop URL. |
| `help` / `aide` / `commandes` | A reminder of all the commands. |

These commands also work as `@tacobot score` etc. in channels (the bot replies in a thread).

## Spending tacos

Every taco you receive lands in your **balance** — a separate counter from your "lifetime received". You spend the balance, not the lifetime number.

To redeem:

1. Open the shop URL (you can DM `@tacobot shop` to get it).
2. Pick an item. The price is in tacos. Some items have a quantity cap; some have notes about what you'll actually get.
3. DM HR (the shop page links you to the right person). Tell them which item you want.
4. HR processes the redemption in the admin console. Your balance drops; HR fulfills the item physically (gift card, swag pickup, whatever the item is).

Redemptions are HR-mediated by design — there's no "buy now" button. Be patient with HR; they're not always at their keyboard.

## FAQ

**The bot didn't react when I gave a taco. Why?**

Most likely: the channel isn't in the allowlist, the bot isn't a member of the channel, you're over your daily limit (check `left`), or you accidentally tried to give to yourself or to the bot. Ask your operator if the channel should be allowlisted.

**Can I give from a private channel?**

Yes, if (a) the channel is in `TACO_CHANNELS` and (b) `@tacobot` has been invited. Otherwise the bot doesn't see your messages.

**What happens to my tacos if I leave the company?**

When your Slack account is deactivated, Tacobot marks your row inactive. Your `received_total` and audit log are preserved, but you won't appear in the leaderboard and you can't give or receive new tacos.

**Can I give tacos in a thread?**

Yes — threaded messages count the same as top-level messages, as long as the parent channel is allowlisted.

**Can I take back a taco I gave by mistake?**

Yes, two ways:

- **By reaction**: remove the 🌮 reaction. The give is reversed — recipient's balance drops, your daily allowance is restored (up to the daily limit). You both get a DM.
- **By message**: delete the Slack message that gave the taco(s). All gives associated with that message are reversed — including any 🌮 reactions other people left on it. Everyone affected gets a DM.

The reversal is recorded as its own row in the audit log (a `type='reversal'` entry referencing the original give); the original give isn't deleted. If you need to give the same taco *again* after reversing, post a new message — re-doing the same reaction on the same message is silently ignored.

**When does the daily reset happen?**

00:00 UTC. If you're east of that, your reset feels like "morning" or "lunch"; west of UTC, it's "late evening" or "the middle of the night".

**Why is the leaderboard showing someone whose name looks like `U02ABC123`?**

Tacobot caches display names but occasionally hasn't seen yours yet (rare, usually only on first interaction). It'll resolve to your real name within a few minutes.
