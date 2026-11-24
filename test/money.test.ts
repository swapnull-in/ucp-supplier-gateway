import { describe, expect, it } from "vitest";
import { toMinorUnits } from "../src/money.js";

describe("toMinorUnits", () => {
  it.each([
    [24.9, "USD", 2490],
    [20.42, "USD", 2042],
    [0.1 + 0.2, "USD", 30], // float noise below currency precision is not real precision
    [1000, "JPY", 1000],
    ["12.345", "KWD", 12345],
    ["7", "EUR", 700],
    [-3.5, "USD", -350],
  ])("%s %s -> %s", (value, currency, expected) => {
    expect(toMinorUnits(value, currency)).toBe(expected);
  });

  it("rejects precision the currency cannot represent", () => {
    expect(() => toMinorUnits("1.005", "USD")).toThrow(RangeError);
    expect(() => toMinorUnits(10.5, "JPY")).toThrow(RangeError);
  });

  it("rejects non-numeric input", () => {
    expect(() => toMinorUnits("12,50", "EUR")).toThrow(RangeError);
    expect(() => toMinorUnits(Number.NaN, "USD")).toThrow(RangeError);
  });
});
