import { describe, expect, it } from "vitest";
import { characterErrorRate } from "./cer";

describe("characterErrorRate", () => {
  it("counts one substitution in three characters", () => {
    expect(characterErrorRate("abc", "adc")).toBeCloseTo(1 / 3);
  });

  it("treats composed and decomposed Vietnamese diacritics as equal", () => {
    expect(characterErrorRate("a\u0301", "\u00e1")).toBe(0);
  });

  it("counts a dropped diacritic as an error", () => {
    expect(characterErrorRate("\u00e1", "a")).toBe(1);
  });

  it("ignores whitespace layout differences only", () => {
    expect(characterErrorRate("a  b\nc", "a b c")).toBe(0);
  });

  it("keeps case and punctuation significant", () => {
    expect(characterErrorRate("Số: 12.", "số: 12")).toBeCloseTo(2 / 7);
  });

  it("measures over code points, not UTF-16 units", () => {
    expect(characterErrorRate("a😀b", "a😁b")).toBeCloseTo(1 / 3);
  });

  it("is zero for two empty strings and infinite for an unexpected insertion", () => {
    expect(characterErrorRate("", "")).toBe(0);
    expect(characterErrorRate("", "x")).toBe(Infinity);
  });
});
