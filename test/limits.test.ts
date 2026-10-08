// Same fixtures in every port (only the imports differ): readings, the forecast, the tiers and
// their confirmation, the parsers, and applyLimit.
import { expect, test } from "vitest";
import {
  DEFAULT_LIMITS as P,
  Tracker,
  applyLimit,
  limitsPolicy,
  readAnthropicHeaders,
  readClaudeCodeLimits,
  readCodexHeaders,
  readCodexUsage,
} from "../src/limits.ts";

const M = 60_000;
const H = 60 * M;
const t0 = Date.UTC(2026, 0, 1);
const at = (min: number) => t0 + min * M;

function feed(t: Tracker, window: string, resetsAt: number, points: [number, number][]) {
  for (const [min, used] of points) t.record({ window, used, resetsAt, at: at(min) });
}

/** Weekly: a slow day, then +2% in the last half hour. */
function weeklyBurst(): [number, number][] {
  const points: [number, number][] = [];
  for (let m = -24 * 60; m <= -30; m += 30) points.push([m, 0.28 - 0.0015 * ((-30 - m) / 60)]);
  points.push([0, 0.3]);
  return points;
}

/** A burst: +44% in the last 20 minutes. */
const burst: [number, number][] = [[-120, 0.2], [-90, 0.22], [-60, 0.24], [-30, 0.26], [-20, 0.4], [-10, 0.55], [0, 0.7]];
/** Steady 24% an hour for two hours. */
const steady: [number, number][] = [[-120, 0.02], [-90, 0.14], [-60, 0.26], [-30, 0.38], [0, 0.5]];

test("absolute use enters a tier at once", () => {
  const t = new Tracker();
  t.record({ window: "5h", used: 0.76, resetsAt: at(120), at: t0 });
  expect(t.assess(t0, P)).toMatchObject({ tier: "caution", steps: 1, window: "5h", reason: "used" });
  t.record({ window: "5h", used: 0.91, resetsAt: at(120), at: at(1) });
  expect(t.assess(at(1), P)).toMatchObject({ tier: "critical", steps: 2 });

  const r = new Tracker();
  for (const reading of readAnthropicHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.4", "anthropic-ratelimit-unified-7d-reset": String(at(600) / 1000), "anthropic-ratelimit-unified-7d-status": "rejected" }, t0)) r.record(reading);
  expect(r.assess(t0, P)).toMatchObject({ tier: "critical", reason: "exhausted", used: 1 });
});

test("a short burst far from the weekly reset stays none", () => {
  const t = new Tracker();
  feed(t, "7d", at(5 * 24 * 60), weeklyBurst());
  const p = t.assess(t0, P);
  expect(p.tier).toBe("none");
  expect(p.warming).toBe(false);
  expect(p.projected!).toBeLessThan(0.9);
});

test("a burst near the 5h reset goes critical at once: it runs out within 30 minutes", () => {
  const t = new Tracker();
  feed(t, "5h", at(60), burst);
  const p = t.assess(t0, P);
  expect(p).toMatchObject({ tier: "critical", steps: 2, reason: "runs out soon", warming: false });
  expect(p.exhaustsAt! - t0).toBeLessThan(30 * M);
});

test("sustained burn past the reset goes caution after a confirming assessment", () => {
  const t = new Tracker();
  feed(t, "5h", at(180), steady);
  const first = t.assess(t0, P);
  expect(first.tier).toBe("none");
  expect(t.view(t0, P)[0]).toMatchObject({ pending: "caution" });
  expect(t.assess(at(4), P).tier).toBe("none");
  t.record({ window: "5h", used: 0.52, resetsAt: at(180), at: at(5) });
  const p = t.assess(at(5), P);
  expect(p.tier).toBe("caution");
  expect(p.projected!).toBeGreaterThan(1);
  expect(p.projected!).toBeLessThan(1.5);
});

test("warm-up: the linear pace stands in until there is enough history", () => {
  // 34% used at 20% of a 5h window elapsed: projected 170%.
  const t = new Tracker();
  t.record({ window: "5h", used: 0.34, resetsAt: at(240), at: t0 });
  const p = t.assess(t0, P);
  expect(p.tier).toBe("none");
  expect(p.warming).toBe(true);
  expect(p.projected!).toBeGreaterThan(1.5);
  expect(t.assess(at(5), P)).toMatchObject({ tier: "critical", warming: true, reason: "pace" });

  // 30% used at 5% elapsed: too early to say anything.
  const early = new Tracker();
  early.record({ window: "5h", used: 0.3, resetsAt: at(285), at: t0 });
  expect(early.assess(t0, P).projected).toBeUndefined();

  // Three readings spanning half an hour switch to the weighted forecast.
  const w = new Tracker();
  feed(w, "5h", at(240), [[-30, 0.3], [-15, 0.31], [0, 0.32]]);
  expect(w.assess(t0, P).warming).toBe(false);
});

test("a window rollover clears the tier at once", () => {
  const t = new Tracker();
  feed(t, "5h", at(180), steady);
  t.assess(t0, P);
  t.record({ window: "5h", used: 0.52, resetsAt: at(180), at: at(5) });
  expect(t.assess(at(5), P).tier).toBe("caution");
  // The reset moved: a new window, so the tier clears at once.
  t.record({ window: "5h", used: 0.52, resetsAt: at(400), at: at(6) });
  expect(t.assess(at(6), P).tier).toBe("none");
});

test("exit: two quiet assessments at least 5 minutes apart", () => {
  const t = new Tracker();
  t.record({ window: "spend_limit", used: 0.8, at: t0, spend: true });
  expect(t.assess(t0, P).tier).toBe("caution");
  // A small drop (under 5 points) is not a new window, and 0.76 stays above 0.70.
  t.record({ window: "spend_limit", used: 0.76, at: at(1), spend: true });
  expect(t.assess(at(1), P).tier).toBe("caution");
  // A drop of 5 points or more is a new window: history and tier start over.
  t.record({ window: "spend_limit", used: 0.6, at: at(2), spend: true });
  expect(t.assess(at(2), P).tier).toBe("none");

  const c = new Tracker();
  feed(c, "5h", at(180), steady);
  c.assess(t0, P);
  c.record({ window: "5h", used: 0.52, resetsAt: at(180), at: at(5) });
  expect(c.assess(at(5), P).tier).toBe("caution");
  for (let m = 10; m <= 90; m += 5) c.record({ window: "5h", used: 0.52, resetsAt: at(180), at: at(m) });
  // Quiet for over an hour: projected at reset is well under 95%, but the first quiet assessment only starts the exit.
  expect(c.assess(at(90), P).tier).toBe("caution");
  expect(c.assess(at(93), P).tier).toBe("caution");
  expect(c.assess(at(95), P).tier).toBe("none");
});

test("old readings count as a minimum, but not for the weighted forecast", () => {
  const t = new Tracker();
  feed(t, "5h", at(180), steady);
  // 20 minutes later, no new reading: absolute and linear pace still apply.
  const p = t.assess(at(20), P);
  expect(p.warming).toBe(true);
  expect(p.used).toBe(0.5);

  const abs = new Tracker();
  abs.record({ window: "5h", used: 0.8, resetsAt: at(120), at: t0 });
  expect(abs.assess(at(20), P).tier).toBe("caution");
  // Past the reset the reading means nothing.
  expect(abs.assess(at(121), P)).toMatchObject({ tier: "none", steps: 0 });
});

test("out-of-order readings are dropped; long gaps give no recent rate", () => {
  const t = new Tracker();
  t.record({ window: "5h", used: 0.5, resetsAt: at(120), at: t0 });
  t.record({ window: "5h", used: 0.1, resetsAt: at(120), at: at(-10) });
  expect(t.readings()[0]!.used).toBe(0.5);

  // Readings an hour apart: the recent rate falls back to the sustained one.
  const g = new Tracker();
  feed(g, "5h", at(100), [[-180, 0.1], [-120, 0.2], [-60, 0.3], [0, 0.4]]);
  const p = g.assess(t0, P);
  expect(p.warming).toBe(false);
  expect(Math.abs(p.projected! - (0.4 + (0.1 / 60) * 100))).toBeLessThan(0.01);
});

test("the worst window wins, and the cut is applied once", () => {
  const t = new Tracker();
  t.record({ window: "5h", used: 0.8, resetsAt: at(120), at: t0 });
  t.record({ window: "7d", used: 0.95, resetsAt: at(3000), at: t0 });
  const p = t.assess(t0, P);
  expect(p).toMatchObject({ tier: "critical", steps: 2, window: "7d" });
  expect(applyLimit("xhigh", p, "low", ["low", "medium", "high", "xhigh", "max"]).level).toBe("medium");
});

test("spend windows never project", () => {
  const t = new Tracker();
  for (let m = -60; m <= 0; m += 10) t.record({ window: "spend_limit", used: 0.3 + (m + 60) / 200, at: at(m), spend: true });
  const p = t.assess(t0, P);
  expect(p.projected).toBeUndefined();
  expect(p.tier).toBe("none");
});

test("disabled: no pressure", () => {
  const t = new Tracker();
  t.record({ window: "5h", used: 0.99, resetsAt: at(60), at: t0 });
  expect(t.assess(t0, { ...P, enabled: false })).toEqual({ tier: "none", steps: 0 });
});

test("settings: invalid values fall back to the defaults", () => {
  const p = limitsPolicy({ enabled: false, caution: { used: "high", projected: 1.2 }, steps: { critical: -1 }, extra: 1 });
  expect(p.enabled).toBe(false);
  expect(p.caution).toEqual({ used: 0.75, projected: 1.2 });
  expect(p.steps).toEqual({ caution: 1, critical: 2 });
  expect(limitsPolicy(undefined)).toEqual(P);
});

test("Anthropic headers: case-insensitive, fractions, reset seconds; token-bucket headers ignored", () => {
  const r = readAnthropicHeaders(
    {
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": "1767232800",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.1",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-tokens-remaining": "1000",
      "anthropic-ratelimit-unified-bad-utilization": "nope",
    },
    t0,
  );
  expect(r).toEqual([
    { window: "5h", used: 0.42, at: t0, resetsAt: 1767232800000 },
    { window: "7d", used: 0.1, at: t0 },
  ]);
  expect(readAnthropicHeaders({ "anthropic-ratelimit-tokens-limit": "80000" }, t0)).toEqual([]);
});

test("Codex headers and usage JSON: percents, seconds, window length", () => {
  expect(
    readCodexHeaders(
      { "x-codex-primary-used-percent": "37.5", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "600", "x-codex-secondary-used-percent": "" },
      t0,
    ),
  ).toEqual([{ window: "primary", used: 0.375, at: t0, resetsAt: t0 + 600_000, lengthMs: 5 * H }]);
  expect(
    readCodexUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 12, reset_at: 1767232800, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 40, reset_after_seconds: 3600 },
        },
        additional_rate_limits: [{ limit_name: "spark", rate_limit: { primary_window: { used_percent: 99 } } }],
      },
      t0,
    ),
  ).toEqual([
    { window: "primary", used: 0.12, at: t0, resetsAt: 1767232800000, lengthMs: 5 * H },
    { window: "secondary", used: 0.4, at: t0, resetsAt: t0 + H },
  ]);
  expect(readCodexUsage({ nothing: true }, t0)).toEqual([]);
  expect(readCodexUsage("garbage", t0)).toEqual([]);
});

test("Claude Code rateLimits: percent, ISO reset, spend limit", () => {
  expect(
    readClaudeCodeLimits(
      [
        { kind: "five_hour", percentUsed: 84, resetsAt: "2026-01-01T02:00:00.000Z" },
        { kind: "spend_limit", percentUsed: 101.5 },
        { kind: "seven_day", percentUsed: "x" },
        "junk",
      ],
      t0,
    ),
  ).toEqual([
    { window: "five_hour", used: 0.84, at: t0, resetsAt: t0 + 2 * H },
    { window: "spend_limit", used: 1.015, at: t0, spend: true },
  ]);
  expect(readClaudeCodeLimits(undefined, t0)).toEqual([]);
});

test("applyLimit steps down the ladder, never below the floor, and leaves unmanaged levels alone", () => {
  const L = ["low", "medium", "high", "xhigh", "max"];
  expect(applyLimit("high", { steps: 1 }, "low", L)).toEqual({ level: "medium", limited: true });
  expect(applyLimit("high", { steps: 2 }, "low", L)).toEqual({ level: "low", limited: true });
  expect(applyLimit("medium", { steps: 2 }, "medium", L)).toEqual({ level: "medium", limited: false });
  expect(applyLimit("low", { steps: 2 }, "medium", L)).toEqual({ level: "low", limited: false });
  expect(applyLimit("off", { steps: 2 }, "low", L)).toEqual({ level: "off", limited: false });
  expect(applyLimit("max", { steps: 0 }, "low", L)).toEqual({ level: "max", limited: false });
});
