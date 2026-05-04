import { afterEach, describe, expect, test, vi } from "vitest";
import { config } from "@/lib/config";

describe("config.taco.altEmojiName", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns undefined when env var is unset", () => {
    vi.stubEnv("TACO_ALT_EMOJI_NAME", "");
    expect(config.taco.altEmojiName).toBeUndefined();
  });

  test("returns the trimmed value when set to a valid emoji name", () => {
    vi.stubEnv("TACO_ALT_EMOJI_NAME", "  wltaco  ");
    expect(config.taco.altEmojiName).toBe("wltaco");
  });

  test("treats the literal 'taco' as effectively unset (no additional emoji)", () => {
    vi.stubEnv("TACO_ALT_EMOJI_NAME", "taco");
    expect(config.taco.altEmojiName).toBeUndefined();
  });

  test("throws if the value contains a colon", () => {
    vi.stubEnv("TACO_ALT_EMOJI_NAME", ":wltaco:");
    expect(() => config.taco.altEmojiName).toThrow(/without colons/);
  });

  test("throws on disallowed characters (e.g. a space)", () => {
    vi.stubEnv("TACO_ALT_EMOJI_NAME", "wl taco");
    expect(() => config.taco.altEmojiName).toThrow(/Allowed characters/);
  });
});

describe("config.taco.acceptedEmojis", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns just ['taco'] when alt emoji is unset", () => {
    vi.stubEnv("TACO_ALT_EMOJI_NAME", "");
    expect(config.taco.acceptedEmojis).toEqual(["taco"]);
  });

  test("returns ['taco', alt] when alt emoji is set", () => {
    vi.stubEnv("TACO_ALT_EMOJI_NAME", "wltaco");
    expect(config.taco.acceptedEmojis).toEqual(["taco", "wltaco"]);
  });
});

describe("config.taco.confirmationEmojiName", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns 'taco' when alt is unset", () => {
    vi.stubEnv("TACO_ALT_EMOJI_NAME", "");
    expect(config.taco.confirmationEmojiName).toBe("taco");
  });

  test("returns the alt emoji when set", () => {
    vi.stubEnv("TACO_ALT_EMOJI_NAME", "wltaco");
    expect(config.taco.confirmationEmojiName).toBe("wltaco");
  });
});
