import { App } from "@slack/bolt";
import { config } from "@/lib/config";
import { AppRouterReceiver } from "./receiver";

/**
 * Bolt App + receiver are lazily constructed on first use.
 *
 * Module-load construction would read SLACK_SIGNING_SECRET / SLACK_BOT_TOKEN
 * eagerly, which crashes `next build`'s page-data collection when secrets
 * aren't present in the build environment. Lazy factories let route modules
 * be imported during build and only fail at runtime if env is misconfigured.
 *
 * Both factories memoize so subsequent calls reuse the same instance.
 */

let _receiver: AppRouterReceiver | undefined;
let _app: App | undefined;

export function getReceiver(): AppRouterReceiver {
  if (!_receiver) {
    _receiver = new AppRouterReceiver(config.slack.signingSecret);
  }
  return _receiver;
}

export function getBoltApp(): App {
  if (!_app) {
    _app = new App({
      token: config.slack.botToken,
      receiver: getReceiver(),
      // FaaS-correct on Vercel: handlers run to completion before the HTTP
      // response is sent, so the function stays alive until they finish.
      // Per docs/bolt-app-router-notes.md (verified via context7).
      processBeforeResponse: true,
    });
  }
  return _app;
}
