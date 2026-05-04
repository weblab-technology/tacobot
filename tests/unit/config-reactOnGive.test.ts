import { afterEach, describe, expect, test, vi } from "vitest";
import { config } from "@/lib/config";

describe("config.taco.reactOnGive", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("defaults to false when env var is unset", () => {
    vi.stubEnv("TACO_REACT_ON_GIVE", "");
    expect(config.taco.reactOnGive).toBe(false);
  });

  test("returns true for 'true' (case-insensitive)", () => {
    vi.stubEnv("TACO_REACT_ON_GIVE", "true");
    expect(config.taco.reactOnGive).toBe(true);
    vi.stubEnv("TACO_REACT_ON_GIVE", "TRUE");
    expect(config.taco.reactOnGive).toBe(true);
    vi.stubEnv("TACO_REACT_ON_GIVE", " True ");
    expect(config.taco.reactOnGive).toBe(true);
  });

  test("returns true for '1'", () => {
    vi.stubEnv("TACO_REACT_ON_GIVE", "1");
    expect(config.taco.reactOnGive).toBe(true);
  });

  test("returns false for 'false' / '0'", () => {
    vi.stubEnv("TACO_REACT_ON_GIVE", "false");
    expect(config.taco.reactOnGive).toBe(false);
    vi.stubEnv("TACO_REACT_ON_GIVE", "0");
    expect(config.taco.reactOnGive).toBe(false);
  });

  test("throws on invalid values", () => {
    vi.stubEnv("TACO_REACT_ON_GIVE", "yes");
    expect(() => config.taco.reactOnGive).toThrow(/Invalid boolean/);
    vi.stubEnv("TACO_REACT_ON_GIVE", "on");
    expect(() => config.taco.reactOnGive).toThrow(/Invalid boolean/);
    vi.stubEnv("TACO_REACT_ON_GIVE", "maybe");
    expect(() => config.taco.reactOnGive).toThrow(/Invalid boolean/);
  });
});
