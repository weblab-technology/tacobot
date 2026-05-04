import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted mocks: pull in the heavy dependencies before the handler module
// resolves them. We're only testing the emoji-name gate, not the give flow.

const acceptedEmojisMock = vi.fn<() => readonly string[]>();

vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/db/queries", () => ({
  ensureUserExists: vi.fn(),
  upsertUser: vi.fn(),
}));
vi.mock("@/lib/slack/execute", () => ({ executeGive: vi.fn() }));
vi.mock("@/lib/slack/reverse", () => ({ executeReactionReversal: vi.fn() }));
vi.mock("@/lib/slack/botUserId", () => ({ getBotUserId: async () => "U_BOT" }));
vi.mock("@/lib/slack/userInfo", () => ({ resolveUserName: async () => null }));
vi.mock("@/lib/config", () => ({
  config: {
    taco: {
      get acceptedEmojis() {
        return acceptedEmojisMock();
      },
      channels: ["C_TAQ"],
      dailyAllowance: 5,
    },
    slack: { botUserId: "U_BOT" },
    admin: { slackIds: [] },
  },
}));

type Handler = (...args: unknown[]) => Promise<void>;

async function captureHandlers(): Promise<Record<string, Handler>> {
  const handlers: Record<string, Handler> = {};
  const fakeApp = {
    event: (name: string, h: Handler) => {
      handlers[name] = h;
    },
  };
  const { registerReactionHandler } = await import("@/lib/slack/handlers/reaction");
  registerReactionHandler(fakeApp as Parameters<typeof registerReactionHandler>[0]);
  return handlers;
}

describe("reaction handler emoji gate", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("reaction_added: bails out for an emoji not in acceptedEmojis", async () => {
    acceptedEmojisMock.mockReturnValue(["taco"]); // alt unset
    const handlers = await captureHandlers();
    const conversationsHistory = vi.fn();

    await handlers.reaction_added({
      event: {
        reaction: "wltaco",
        item: { type: "message", channel: "C_TAQ", ts: "1.0" },
        user: "U_R",
      },
      client: { conversations: { history: conversationsHistory } },
    });

    expect(conversationsHistory).not.toHaveBeenCalled();
  });

  test("reaction_added: proceeds for the alt emoji when it's in acceptedEmojis", async () => {
    acceptedEmojisMock.mockReturnValue(["taco", "wltaco"]);
    const handlers = await captureHandlers();
    // First call after the gate: conversations.history. We make it throw to
    // short-circuit before any DB work — proving the gate let us through is
    // enough; the rest of the handler is covered by reaction-give tests.
    const conversationsHistory = vi.fn().mockRejectedValue(new Error("stop here"));

    await handlers.reaction_added({
      event: {
        reaction: "wltaco",
        item: { type: "message", channel: "C_TAQ", ts: "1.0" },
        user: "U_R",
      },
      client: { conversations: { history: conversationsHistory } },
    });

    expect(conversationsHistory).toHaveBeenCalledOnce();
  });

  test("reaction_added: still proceeds for :taco: regardless of alt setting", async () => {
    acceptedEmojisMock.mockReturnValue(["taco", "wltaco"]);
    const handlers = await captureHandlers();
    const conversationsHistory = vi.fn().mockRejectedValue(new Error("stop here"));

    await handlers.reaction_added({
      event: {
        reaction: "taco",
        item: { type: "message", channel: "C_TAQ", ts: "1.0" },
        user: "U_R",
      },
      client: { conversations: { history: conversationsHistory } },
    });

    expect(conversationsHistory).toHaveBeenCalledOnce();
  });

  test("reaction_removed: bails out for an emoji not in acceptedEmojis", async () => {
    acceptedEmojisMock.mockReturnValue(["taco"]);
    const handlers = await captureHandlers();
    const { executeReactionReversal } = await import("@/lib/slack/reverse");

    await handlers.reaction_removed({
      event: {
        reaction: "wltaco",
        item: { type: "message", channel: "C_TAQ", ts: "1.0" },
        user: "U_R",
      },
      client: { chat: { postMessage: vi.fn() } },
    });

    expect(executeReactionReversal).not.toHaveBeenCalled();
  });

  test("reaction_removed: proceeds for the alt emoji when it's in acceptedEmojis", async () => {
    acceptedEmojisMock.mockReturnValue(["taco", "wltaco"]);
    const handlers = await captureHandlers();
    const { executeReactionReversal } = await import("@/lib/slack/reverse");
    vi.mocked(executeReactionReversal).mockResolvedValue({ kind: "noop" });

    await handlers.reaction_removed({
      event: {
        reaction: "wltaco",
        item: { type: "message", channel: "C_TAQ", ts: "1.0" },
        user: "U_R",
      },
      client: { chat: { postMessage: vi.fn() } },
    });

    expect(executeReactionReversal).toHaveBeenCalledOnce();
  });
});
