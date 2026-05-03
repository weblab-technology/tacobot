# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tacobot is a Slack bot (inspired by HeyTaco) that lets users reward each other with `:taco:` reactions. Each user has a daily allowance of 5 tacos to give; counts and balances are persisted in a local JSON file.

## Commands

- `yarn install` — install dependencies
- `yarn start` — runs `index.js` under `nodemon` with `NODE_ENV=development` (the only real way to run the bot)
- `yarn test-slack` — runs `slack.test.js` (just calls `slack.getAllUsers()` once)
- `yarn test-taco` — runs `taco.test.js` (just calls `taco.giveTaco("kevin")`)

There is **no test runner, linter, or CI**. The `*.test.js` files are not real tests — the README explicitly notes "tests are not up to date and are legacy of quick developing". Treat them as throwaway smoke scripts. Engine pin is Node 10.x in `package.json`.

## Required local setup before running

Two files are gitignored and must exist locally for the bot to start:

- `config.js` — exports `{ controller, token }` with Slack app credentials. The shape is documented in `README.md` (clientId, clientSecret, scopes, clientSigningSecret, clientVerificationToken, plus the bot OAuth `token`). `index.js` and `slack.js` both `require("./config.js")` at load time, so missing config is a hard crash.
- `db.json` — auto-generated on first successful RTM connect via `taco.init()` → `slack.getAllUsers()`.

## Architecture

Single-process Node app. Entry point `index.js` wires four pieces together:

1. **Botkit RTM** (`index.js`) — `Botkit.slackbot(config.controller)` + `bot.startRTM()`. On `rtm_close` it retries indefinitely (60s backoff). On successful connect it calls `taco.init()` (populate DB if missing) then `tacobot.listens(controller)` (register handlers). A `node-schedule` job at 00:00 daily calls `taco.resetLeft()` to refill every user's allowance to 5.

2. **Message handlers** (`bot.js`) — registers four `controller.hears` listeners:
   - `:taco:` on `ambient` → finds mentioned user via `parser.findID`, counts tacos via `parser.countTacos`, validates sender has enough `left`, then `giveTaco` + `removeLeft` + adds `:taco:` reaction.
   - `score`/`ranking` on `direct_mention`/`direct_message` → top-5 leaderboard.
   - `left`/`how many`/`how much`/`combien` on `direct_message` → reports caller's remaining allowance.
   - `help`/`aide`/`commandes` on direct → help text.

3. **Domain logic** (`taco.js`) — `init`/`populate` pulls all Slack users via `slack.getAllUsers()`, formats to `{id, name, tacos: 0, left: 5}`, and merges with existing DB rows (preserves counts; updates names). `giveTaco`/`removeLeft`/`resetLeft` are index-based mutations on the user array.

4. **Persistence** (`db.js`) — The "database" is a single `db.json` written via `fs.writeFileSync` on every change. All reads re-read the file. There is no caching, no transactions, and no concurrency control — every handler invocation does a full read-modify-write cycle. Users are addressed by **array index**, not ID, so `DB.getUser(index)` ordering must stay stable; `taco.writeMembers` rewrites the whole array.

5. **Slack web API** (`slack.js`) — direct `axios` GET to `https://slack.com/api/users.list` with `Bearer ${config.token}`, capped at `limit: 100` (no pagination). Used only during DB population, separate from Botkit's RTM connection.

6. **Parsing** (`parser.js`) — `findID` matches `<@\S*>` and strips `<@` and `>`. Note this does not handle the `<@USERID|username>` form Slack sometimes emits. `countTacos` matches `:taco:` globally; it will throw on messages without `:taco:` because `match()` returns `null` (the `:taco:` ambient hear filter prevents this in practice).

## Conventions worth keeping in mind

- CommonJS only (`require`/`module.exports`). No TypeScript, no Babel.
- Two-space indent, double-quoted strings, no semicolon strictness — match existing style.
- `bot.js` handlers all follow the same shape: read DB, mutate array by index, write DB, reply via `bot.reply`/`bot.api.*`.
- Daily allowance is hardcoded to 5 in two places: `taco.writeMembers` (initial value) and `taco.resetLeft` (reset value). Keep them in sync.
