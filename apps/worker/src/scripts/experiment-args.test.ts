import { describe, expect, it } from "vitest";
import { parseExperimentArgs } from "./experiment-args";

describe("parseExperimentArgs", () => {
  it("defaults to Genesis 24H", () => {
    const c = parseExperimentArgs([]);
    expect(c.name).toBe("Genesis 24H");
    expect(c.agentCount).toBe(20);
    expect(c.startingCapitalXrp).toBe(10);
    expect(c.durationHours).toBe(24);
    expect(c.objectiveDistribution.map((o) => o.count)).toEqual([5, 5, 5, 5]);
  });

  it("scales the experiment and splits objectives evenly", () => {
    const c = parseExperimentArgs(["--agents", "8", "--hours=0.5", "--capital", "2"]);
    expect(c.agentCount).toBe(8);
    expect(c.durationHours).toBe(0.5);
    expect(c.objectiveDistribution.map((o) => o.count)).toEqual([2, 2, 2, 2]);
  });

  it("rejects bad flags", () => {
    expect(() => parseExperimentArgs(["--agents", "6"])).toThrow(/multiple of 4/);
    expect(() => parseExperimentArgs(["--hours", "-1"])).toThrow(/positive/);
    expect(() => parseExperimentArgs(["--brain", "oracle"])).toThrow(/deterministic or llm/);
  });
});
