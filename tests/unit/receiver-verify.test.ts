import { describe, expect, test } from "vitest";
import crypto from "node:crypto";
import { AppRouterReceiver } from "@/lib/slack/receiver";

const SECRET = "test-secret";

function sign(body: string, ts: string): string {
  const base = `v0:${ts}:${body}`;
  return `v0=${crypto.createHmac("sha256", SECRET).update(base).digest("hex")}`;
}

describe("AppRouterReceiver signature verification", () => {
  test("rejects requests with no timestamp", async () => {
    const r = new AppRouterReceiver(SECRET);
    const res = await r.handle(
      new Request("http://localhost/api/slack/events", {
        method: "POST",
        body: "{}",
        headers: { "x-slack-signature": "x" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("rejects requests with stale timestamp", async () => {
    const r = new AppRouterReceiver(SECRET);
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 10);
    const body = "{}";
    const res = await r.handle(
      new Request("http://localhost/api/slack/events", {
        method: "POST",
        body,
        headers: {
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sign(body, ts),
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("rejects invalid signature", async () => {
    const r = new AppRouterReceiver(SECRET);
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await r.handle(
      new Request("http://localhost/api/slack/events", {
        method: "POST",
        body: "{}",
        headers: {
          "x-slack-request-timestamp": ts,
          "x-slack-signature": "v0=deadbeef",
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("accepts valid url_verification handshake", async () => {
    const r = new AppRouterReceiver(SECRET);
    // App must be initialized for handle() to use this.app — but
    // url_verification short-circuits before processEvent. We init with
    // a stub object cast to App.
    r.init({ processEvent: async () => {} } as never);
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await r.handle(
      new Request("http://localhost/api/slack/events", {
        method: "POST",
        body,
        headers: {
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sign(body, ts),
        },
      }),
    );
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.challenge).toBe("abc123");
  });
});
