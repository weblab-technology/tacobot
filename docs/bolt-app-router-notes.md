# Bolt + Next.js App Router — verified pattern (2026-05-02)

Notes captured from context7 lookup against `slack_dev_tools_bolt-js` for
implementing Task 12 of the Tacobot rebuild plan.

## Receiver interface

A custom Bolt receiver implements four methods:

```ts
interface Receiver {
  init(app: App): void;            // App calls this to wire itself in
  start(...args): Promise<unknown>; // for HTTP-style receivers, can be a no-op
  stop(...args): Promise<unknown>; // can be a no-op
  // plus: a request-handling method we expose to the route
}
```

The request-handling method is not part of the formal `Receiver` interface but is
how the receiver is actually used. For Express/HTTP receivers it's `requestHandler(req, res)`.
For our App Router adapter, we expose `handle(req: Request): Promise<Response>`.

## Dispatch

In the request handler, build a `ReceiverEvent` with two required fields and call
`this.app.processEvent(event)`:

```ts
const event: ReceiverEvent = {
  body: parsedJsonBody,         // already-parsed Slack event body
  ack: async (response) => {
    // Set the response that will be returned. Called by handlers; receiver
    // captures the value and uses it to build the HTTP response.
    // - undefined → 200 with empty body
    // - string → 200 with that body
    // - object → 200 with JSON body
    // - Error → 500
    // Idempotent: only the first call matters.
  },
};
await this.app.processEvent(event);
```

## ack semantics

`ack` is called by event handlers (or the receiver itself for things like
`url_verification`) to signal "received". The Bolt convention:

- Call with no argument or `""` → empty 200.
- Call with a string or object → 200 with that body.
- Call with an `Error` → 500.

Receiver must guard against multiple `ack` calls; only the first counts.

## processBeforeResponse for FaaS / serverless

For FaaS-style deployments (AWS Lambda, Vercel functions), set
`processBeforeResponse: true` on the App constructor. With this flag:

- Handlers run to completion BEFORE the receiver sends the HTTP response.
- The function stays alive until handlers finish.
- Slack's 3-second ACK requirement applies to total handler runtime.

For our use case (Vercel Pro, 60s function timeout, fast DB-only handlers),
this is the right setting. We don't need a `waitUntil`-based async pattern
because all our handlers complete in <500ms (DB roundtrip + maybe a Slack API
call). If we ever add slow background work, we'll move to `waitUntil`.

## URL verification handshake

Slack pings the events URL with `{type: "url_verification", challenge: "..."}`
during initial setup. The receiver should short-circuit this BEFORE
`processEvent` (which doesn't know about it), responding with
`{ challenge: <value> }`.

## Signing secret verification

Bolt's built-in receivers verify the signing secret automatically. For a custom
receiver in App Router, we do it ourselves on the raw body:

1. Read raw body via `await req.text()`.
2. Get `x-slack-request-timestamp` and `x-slack-signature` headers.
3. Reject if timestamp is more than 5 minutes off (replay protection).
4. Compute HMAC-SHA256(`v0:${ts}:${rawBody}`, signingSecret).
5. Compare against signature using `crypto.timingSafeEqual`.

`req.text()` (Web standard `Request`) gives the raw body as a string, which is
what HMAC-SHA256 wants. Don't use `req.json()` — it parses, which may
canonicalize (whitespace, key order) and break the signature.

## Implementation shape for `/api/slack/events/route.ts`

```ts
import { receiver } from "@/lib/slack/bolt";
import "@/lib/slack/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return receiver.handle(req);
}
```

The side-effect import of `handlers` registers all `app.event(...)` listeners
once at module load.

## Confirmed: plan's Task 12 receiver shape is correct

The receiver code in the plan (with `init`, `start`, `stop`, `handle`,
`processEvent`, `ack` callback) matches the documented Bolt 4.x custom-receiver
contract. One note for implementation:

- Pass `processBeforeResponse: true` when constructing the `App` so handlers
  finish before the receiver sends the HTTP response. This is the FaaS-correct
  setting for Vercel.
