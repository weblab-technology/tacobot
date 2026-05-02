function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
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
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function intWithDefault(name: string, fallback: number): number {
  const v = optional(name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid integer for ${name}: ${v}`);
  }
  return n;
}

export const config = {
  slack: {
    botToken: required("SLACK_BOT_TOKEN"),
    signingSecret: required("SLACK_SIGNING_SECRET"),
    botUserId: optional("SLACK_BOT_USER_ID"),
    clientId: optional("SLACK_CLIENT_ID"),         // required for admin OIDC
    clientSecret: optional("SLACK_CLIENT_SECRET"), // required for admin OIDC
  },
  taco: {
    channels: csv("TACO_CHANNELS"),
    dailyAllowance: intWithDefault("TACO_DAILY_ALLOWANCE", 5),
  },
  admin: {
    slackIds: csv("ADMIN_SLACK_IDS"),
  },
  shopUrl: optional("NEXT_PUBLIC_SHOP_URL") ?? "/shop",
  cronSecret: optional("CRON_SECRET"),
} as const;

export type AppConfig = typeof config;
