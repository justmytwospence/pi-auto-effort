import { describe, expect, test } from "vitest";
import { DEFAULT_POLICY, type EffortState, decide } from "../src/policy.ts";

const fresh = (ceiling = "xhigh"): EffortState => ({ dwell: DEFAULT_POLICY.minDwell, ceiling });
const j = (score: number, confidence = 0.9, ack = 0) => ({ score, confidence, ack });

describe("decide", () => {
  test("a trivial first message steps down from the manual level", () => {
    const d = decide("xhigh", fresh(), j(0), DEFAULT_POLICY);
    expect(d).toMatchObject({ level: "low", reason: "down", state: { e: 0, dwell: 0 } });
  });

  test("going down waits for the dwell", () => {
    const d = decide("high", { e: 2, dwell: 0, ceiling: "xhigh" }, j(0), DEFAULT_POLICY);
    expect(d.level).toBe("high");
    expect(d.state).toMatchObject({ e: 1, dwell: 1 });
    const later = decide("high", { ...d.state, dwell: 2 }, j(0), DEFAULT_POLICY);
    expect(later).toMatchObject({ level: "medium", reason: "down", state: { e: 0.5 } });
  });

  test("a confident hard message jumps straight up", () => {
    const d = decide("low", { e: 0, dwell: 0, ceiling: "xhigh" }, j(3, 0.8), DEFAULT_POLICY);
    expect(d).toMatchObject({ level: "xhigh", reason: "jump" });
  });

  test("an unsure hard message moves up through the average", () => {
    const d = decide("low", { e: 0.5, dwell: 0, ceiling: "xhigh" }, j(2.6, 0.3), DEFAULT_POLICY);
    expect(d).toMatchObject({ level: "high", reason: "up" });
    expect(d.state.e).toBeCloseTo(1.55);
  });

  test("small changes hold the level", () => {
    const d = decide("medium", { e: 1, dwell: 5, ceiling: "xhigh" }, j(1.4), DEFAULT_POLICY);
    expect(d).toMatchObject({ level: "medium", reason: "hold" });
  });

  test("a go-ahead keeps the level", () => {
    const d = decide("high", { e: 2, dwell: 5, ceiling: "xhigh" }, j(0, 0.9, 0.95), DEFAULT_POLICY);
    expect(d).toMatchObject({ level: "high", reason: "ack" });
  });

  test("the manual level is the ceiling and low the floor", () => {
    expect(decide("medium", { e: 1, dwell: 0, ceiling: "medium" }, j(3, 0.9), DEFAULT_POLICY).level).toBe("medium");
    expect(decide("medium", { e: 0, dwell: 9, ceiling: "high" }, j(0), DEFAULT_POLICY).level).toBe("low");
  });

  test("levels outside the managed range and missing judgments are left alone", () => {
    expect(decide("off", fresh("off"), j(3), DEFAULT_POLICY).level).toBe("off");
    expect(decide("minimal", fresh("minimal"), j(3), DEFAULT_POLICY).level).toBe("minimal");
    expect(decide("high", fresh(), undefined, DEFAULT_POLICY)).toMatchObject({ level: "high", reason: "unavailable" });
  });
});
