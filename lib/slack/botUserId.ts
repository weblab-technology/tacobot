import { getBoltApp } from "./bolt";
import { config } from "@/lib/config";

let cached: string | undefined = config.slack.botUserId;
let inflight: Promise<string> | undefined;

export async function getBotUserId(): Promise<string> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await getBoltApp().client.auth.test({ token: config.slack.botToken });
    if (!res.user_id) throw new Error("auth.test returned no user_id");
    cached = res.user_id;
    return cached;
  })();
  try {
    return await inflight;
  } finally {
    inflight = undefined;
  }
}
