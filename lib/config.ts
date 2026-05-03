/**
 * Env-var access for the app.
 *
 * Properties are lazy: validation runs on read, not on module-load. This means
 * importing `@/lib/config` is always safe (no top-level throws), so build-time
 * page-data collection in Next.js can import route modules without secrets
 * being set. Missing values surface only when handlers actually run.
 *
 * Error messages include the variable name AND a hint about where it's used,
 * so deploy-time failures point at the right thing to fix in the dashboard.
 */

type RequiredVar = {
  name: string;
  /** Where this value is used — included in the error message. */
  usedFor: string;
};

function required({ name, usedFor }: RequiredVar): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var: ${name}. Used for: ${usedFor}. ` +
        `Set it in Vercel → Settings → Environment Variables (or .env.local).`,
    );
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

function csv(name: string): string[] {
  const v = optional(name);
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function intWithDefault(name: string, fallback: number): number {
  const v = optional(name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(
      `Invalid integer for env var ${name}: ${v}. Must be a positive integer.`,
    );
  }
  return n;
}

export const config = {
  slack: {
    get botToken(): string {
      return required({
        name: "SLACK_BOT_TOKEN",
        usedFor: "Bolt App auth.test, posting messages, adding reactions",
      });
    },
    get signingSecret(): string {
      return required({
        name: "SLACK_SIGNING_SECRET",
        usedFor: "verifying inbound Slack event signatures",
      });
    },
    get botUserId(): string | undefined {
      return optional("SLACK_BOT_USER_ID");
    },
    get clientId(): string | undefined {
      return optional("SLACK_CLIENT_ID");
    },
    get clientSecret(): string | undefined {
      return optional("SLACK_CLIENT_SECRET");
    },
  },
  taco: {
    get channels(): string[] {
      return csv("TACO_CHANNELS");
    },
    get dailyAllowance(): number {
      return intWithDefault("TACO_DAILY_ALLOWANCE", 5);
    },
  },
  admin: {
    get slackIds(): string[] {
      return csv("ADMIN_SLACK_IDS");
    },
  },
  get shopUrl(): string {
    return optional("NEXT_PUBLIC_SHOP_URL") ?? "/shop";
  },
  get cronSecret(): string | undefined {
    return optional("CRON_SECRET");
  },
};

export type AppConfig = typeof config;
