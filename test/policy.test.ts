import { describe, expect, test } from "vitest";
import { applyLimit } from "../src/limits.ts";
import { DEFAULT_POLICY, type EffortState, LEVELS, decide, trend } from "../src/policy.ts";

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
    expect(d).toMatchObject({ level: "xhigh", reason: "jump", state: { e: 3 } });
  });

  test("a jump is not undone by the stale average", () => {
    const jumped = decide("low", { e: 0, dwell: 5, ceiling: "xhigh" }, j(3, 0.8), DEFAULT_POLICY);
    const d = decide(jumped.level, { ...jumped.state, dwell: 5 }, j(2.5), DEFAULT_POLICY);
    expect(d).toMatchObject({ level: "xhigh", reason: "hold" });
    expect(d.state.e).toBeCloseTo(2.75);
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
    expect(d).toMatchObject({ level: "high", reason: "ack", state: { e: 2, dwell: 6 } });
  });

  test("a go-ahead does not drag the average down for the next message", () => {
    const ack = decide("high", { e: 2, dwell: 5, ceiling: "xhigh" }, j(0, 0.9, 0.95), DEFAULT_POLICY);
    const next = decide("high", ack.state, j(1.5), DEFAULT_POLICY);
    expect(next).toMatchObject({ level: "high", reason: "hold" });
    expect(next.state.e).toBeCloseTo(1.75);
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

  test("a limit on top never ratchets the policy's own level down, and lifting it restores that level", () => {
    let baseline = "high";
    let state: EffortState = { e: 2, dwell: 5, ceiling: "xhigh" };
    for (let i = 0; i < 5; i++) {
      const d = decide(baseline, state, j(2), DEFAULT_POLICY);
      state = d.state;
      baseline = d.level;
      expect(applyLimit(baseline, { steps: 2 }, DEFAULT_POLICY.floor, LEVELS).level).toBe("low");
    }
    expect(baseline).toBe("high");
    expect(state.e).toBeCloseTo(2);
    expect(state.dwell).toBe(10);
    expect(applyLimit(baseline, { steps: 0 }, DEFAULT_POLICY.floor, LEVELS).level).toBe("high");
  });
});

test("trend points where the average is pulling, within the bounds", () => {
  const s = (e: number | undefined, ceiling = "xhigh") => ({ e, dwell: 0, ceiling });
  expect(trend("medium", s(1.5), DEFAULT_POLICY)).toBe("up");
  expect(trend("medium", s(1.2), DEFAULT_POLICY)).toBeUndefined();
  expect(trend("high", s(1.6), DEFAULT_POLICY)).toBe("down");
  expect(trend("high", s(2.9, "high"), DEFAULT_POLICY)).toBeUndefined();
  expect(trend("low", s(0, "high"), DEFAULT_POLICY)).toBeUndefined();
  expect(trend("medium", s(undefined), DEFAULT_POLICY)).toBeUndefined();
  expect(trend("minimal", s(3), DEFAULT_POLICY)).toBeUndefined();
});
