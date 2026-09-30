import { describe, expect, it } from "vitest";
import { SeededRandom } from "./random";
import { deterministicId } from "./ids";

describe("SeededRandom", () => {
  it("is reproducible for the same seed", () => {
    const a = new SeededRandom("genesis");
    const b = new SeededRandom("genesis");
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("differs for different seeds", () => {
    expect(new SeededRandom("a").next()).not.toBe(new SeededRandom("b").next());
  });

  it("derives stable ids", () => {
    expect(deterministicId("agent", "exp:1:0")).toBe(deterministicId("agent", "exp:1:0"));
    expect(deterministicId("agent", "exp:1:0")).not.toBe(deterministicId("agent", "exp:1:1"));
    expect(deterministicId("agent", "x")).toMatch(/^agt_[0-9a-z]{16}$/);
  });
});
