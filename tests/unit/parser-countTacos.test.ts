import { describe, expect, test } from "vitest";
import { countTacos } from "@/lib/slack/parser";

describe("countTacos", () => {
  test("returns 0 for text with no taco emoji", () => {
    expect(countTacos("Thanks!")).toBe(0);
  });

  test("counts a single :taco:", () => {
    expect(countTacos("Thanks :taco:")).toBe(1);
  });

  test("counts multiple :taco: in a row", () => {
    expect(countTacos(":taco: :taco: :taco:")).toBe(3);
  });

  test("counts non-adjacent :taco: anywhere in the message", () => {
    expect(countTacos("nice :taco: work team :taco:")).toBe(2);
  });

  test("ignores other emoji", () => {
    expect(countTacos(":heart: :pizza: :taco: :coffee:")).toBe(1);
  });

  test("does not match :tacos: or :taco_truck:", () => {
    expect(countTacos(":tacos: :taco_truck:")).toBe(0);
  });

  test("handles empty string", () => {
    expect(countTacos("")).toBe(0);
  });

  test("accepts an alt emoji name in addition to :taco:", () => {
    expect(countTacos(":wltaco:", ["taco", "wltaco"])).toBe(1);
    expect(countTacos(":taco: :wltaco:", ["taco", "wltaco"])).toBe(2);
    expect(countTacos("nice :wltaco: work :taco:", ["taco", "wltaco"])).toBe(2);
  });

  test("does not match :wltaco: when only the default set is used", () => {
    expect(countTacos(":wltaco:")).toBe(0);
  });

  test("anchors on closing colon for alt emoji too (no false positive on :wltacos:)", () => {
    expect(countTacos(":wltacos: :wltaco_truck:", ["taco", "wltaco"])).toBe(0);
  });

  test("escapes regex special characters in emoji names", () => {
    expect(countTacos(":foo+bar: :foo:bar:", ["foo+bar"])).toBe(1);
  });
});
