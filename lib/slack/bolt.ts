import { App } from "@slack/bolt";
import { config } from "@/lib/config";
import { AppRouterReceiver } from "./receiver";

export const receiver = new AppRouterReceiver(config.slack.signingSecret);

export const boltApp = new App({
  token: config.slack.botToken,
  receiver,
  // FaaS-correct on Vercel: handlers run to completion before the HTTP
  // response is sent, so the function stays alive until they finish.
  // Per docs/bolt-app-router-notes.md (verified via context7).
  processBeforeResponse: true,
});
