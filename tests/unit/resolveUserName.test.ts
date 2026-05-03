import { beforeEach, describe, expect, test, vi } from "vitest";

const usersInfo = vi.fn();

vi.mock("@/lib/slack/bolt", () => ({
  getBoltApp: () => ({ client: { users: { info: usersInfo } } }),
}));

import {
  _resetUserInfoCacheForTests,
  pickName,
  resolveUserName,
} from "@/lib/slack/userInfo";

beforeEach(() => {
  usersInfo.mockReset();
  _resetUserInfoCacheForTests();
});

describe("pickName", () => {
  test("prefers display_name", () => {
    expect(
      pickName({
        profile: { display_name: "Display", real_name: "Real" },
        name: "handle",
      }),
    ).toBe("Display");
  });
  test("falls back to real_name", () => {
    expect(pickName({ profile: { real_name: "Real" }, name: "handle" })).toBe(
      "Real",
    );
  });
  test("falls back to name", () => {
    expect(pickName({ name: "handle" })).toBe("handle");
  });
  test("returns null when nothing usable", () => {
    expect(pickName({})).toBeNull();
    expect(pickName({ name: "  " })).toBeNull();
  });
});

describe("resolveUserName", () => {
  test("calls users.info on cache miss and applies pickName", async () => {
    usersInfo.mockResolvedValueOnce({
      user: { profile: { display_name: "Alice" } },
    });
    const name = await resolveUserName("U1");
    expect(name).toBe("Alice");
    expect(usersInfo).toHaveBeenCalledTimes(1);
    expect(usersInfo).toHaveBeenCalledWith({ user: "U1" });
  });

  test("returns cached name without calling users.info", async () => {
    usersInfo.mockResolvedValueOnce({
      user: { profile: { display_name: "Alice" } },
    });
    await resolveUserName("U1");
    const name = await resolveUserName("U1");
    expect(name).toBe("Alice");
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  test("dedupes concurrent in-flight calls", async () => {
    let resolve!: (v: unknown) => void;
    usersInfo.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const a = resolveUserName("U1");
    const b = resolveUserName("U1");
    resolve({ user: { profile: { display_name: "Alice" } } });
    expect(await a).toBe("Alice");
    expect(await b).toBe("Alice");
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  test("returns null on bot user without caching", async () => {
    usersInfo.mockResolvedValueOnce({
      user: { is_bot: true, profile: { display_name: "Bot" } },
    });
    expect(await resolveUserName("U_BOT")).toBeNull();
    usersInfo.mockResolvedValueOnce({
      user: { profile: { display_name: "Real" } },
    });
    expect(await resolveUserName("U_BOT")).toBe("Real");
    expect(usersInfo).toHaveBeenCalledTimes(2);
  });

  test("returns null on deleted user without caching", async () => {
    usersInfo.mockResolvedValueOnce({
      user: { deleted: true, profile: { display_name: "Gone" } },
    });
    expect(await resolveUserName("U_DEL")).toBeNull();
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  test("returns null on API failure and does not cache", async () => {
    usersInfo.mockRejectedValueOnce(new Error("boom"));
    expect(await resolveUserName("U_X")).toBeNull();
    usersInfo.mockResolvedValueOnce({
      user: { profile: { display_name: "Recovered" } },
    });
    expect(await resolveUserName("U_X")).toBe("Recovered");
    expect(usersInfo).toHaveBeenCalledTimes(2);
  });
});
