# Slack App Setup (one-time, manual)

Operator checklist for configuring the Slack app that backs Tacobot. Required before the bot can receive events or admins can sign in.

## 1. Create the app

Go to <https://api.slack.com/apps?new_app=1> → **From scratch**.

- App name: `Tacobot`
- Workspace: `wlt-and-shaman`

## 2. Bot token scopes

Slack app dashboard → **OAuth & Permissions** → **Bot Token Scopes**. Add:

- `chat:write`
- `reactions:write`
- `reactions:read`
- `users:read`
- `channels:history`
- `groups:history`
- `im:history`
- `app_mentions:read`
- `team:read`

## 3. Event subscriptions

**Event Subscriptions** → toggle **Enable Events** on.

- Request URL: `https://<deploy-host>/api/slack/events`
  - During setup, point at a Vercel preview URL.
  - On launch, flip to the production URL.
- Subscribe to bot events:
  - `message.channels`
  - `message.im`
  - `app_mention`
  - `reaction_added`
  - `team_join`
  - `user_change`

Save changes. Slack issues a verification challenge against the request URL; the route handler echoes it back. Confirm the green check.

## 4. Sign in with Slack (admin pages)

**OAuth & Permissions** → **Redirect URLs**. Add:

- `https://<deploy-host>/api/auth/callback/slack`

In **OpenID Connect** (or **User Token Scopes**, depending on the dashboard layout), add:

- `openid`
- `profile`
- `email`

## 5. Install the app to the workspace

**Install App** → **Install to Workspace** → **Allow**. Then collect:

| Value | From | Env var |
|---|---|---|
| Bot User OAuth Token (`xoxb-…`) | OAuth & Permissions → after install | `SLACK_BOT_TOKEN` |
| Signing Secret | Basic Information | `SLACK_SIGNING_SECRET` |
| Client ID | Basic Information | `SLACK_CLIENT_ID` |
| Client Secret | Basic Information | `SLACK_CLIENT_SECRET` |
| Bot User ID | App Home → Bot details | `SLACK_BOT_USER_ID` |

## 6. Channel IDs for the allowlist

Right-click the channel in Slack → **View channel details** → ID at the bottom. Or read it from the URL: `/archives/C0123ABCDE`.

Set `TACO_CHANNELS=<id>` (comma-separated for multiple). During the beta:

```bash
TACO_CHANNELS=<id of #taqueria-beta>
```

After cutover from HeyTaco:

```bash
TACO_CHANNELS=<id of #taqueria>
```

## 7. Invite the bot

In Slack, run inside the allowlisted channel(s):

```
/invite @tacobot
```

The bot must be a member of every channel in `TACO_CHANNELS`. Slack only delivers `message.channels` events for channels where the bot is a member, so this is the natural enforcement.

## 8. Admin allowlist

Set `ADMIN_SLACK_IDS` to the comma-separated Slack user IDs that should have access to `/admin/*` pages. Adding/removing an admin is an env-var change + redeploy.
