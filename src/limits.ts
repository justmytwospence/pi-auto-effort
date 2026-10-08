// Subscription limits: readings of the account's rate-limit windows (Anthropic 5h/7d, Codex
// primary/secondary, Claude Code's spend limit), a forecast of where each window will be when it
// resets, and a tier (none, caution, critical) that lowers the effort one or two levels. This file
// is copied verbatim into the pi, opencode and Claude Code ports; it is pure (no I/O, no clock),
// and readings live in process memory only.
//
// The forecast weights recent use by how close the reset is: a recent rate (the last hour) and a
// sustained rate (the last day), with the recent burst decaying toward the sustained rate over
// `tau`. Near a 5h reset the burst dominates; across a week it fades. Until a window has enough
// history the linear pace (used / fraction of the window elapsed, as in CodexBar) stands in.

/** One window's state at one moment. `used` is a fraction (1 = the whole allowance). */
export interface Reading {
  window: string;
  used: number;
  /** When the window resets, in ms since the epoch. */
  resetsAt?: number;
  /** The window's length in ms, when the source says. */
  lengthMs?: number;
  /** When the reading was taken, in ms since the epoch. */
  at: number;
  /** A spend limit: absolute thresholds only, never projected. */
  spend?: boolean;
  /** The provider reports the window as exceeded. */
  exhausted?: boolean;
}

export type Tier = "none" | "caution" | "critical";
const TIERS: readonly Tier[] = ["none", "caution", "critical"];
const rank = (t: Tier) => TIERS.indexOf(t);

export interface Pressure {
  tier: Tier;
  /** Levels to lower the effort by. */
  steps: number;
  window?: string;
  /** The window's display name ("5h", "7d", "five_hour"). */
  label?: string;
  used?: number;
  projected?: number;
  exhaustsAt?: number;
  /** The forecast is the linear pace: too little history for the weighted one. */
  warming?: boolean;
  reason?: string;
}

/** One window as `/auto-effort status` shows it. */
export interface WindowView {
  window: string;
  label: string;
  used: number;
  elapsed?: number;
  projected?: number;
  exhaustsAt?: number;
  resetsAt?: number;
  ageMs: number;
  tier: Tier;
  warming: boolean;
  /** A tier change waiting for its confirming assessment. */
  pending?: Tier;
}

export interface LimitsPolicy {
  enabled: boolean;
  caution: { used: number; projected: number };
  critical: { used: number; projected: number; exhaustMinutes: number };
  steps: { caution: number; critical: number };
  /** A tier lifts only once the projected use at reset is at most this (caution) ... */
  exitProjected: number;
  /** ... and use is this far below the tier's threshold. */
  hysteresis: number;
  /** A forecast-based change must hold at two assessments this far apart. */
  confirmMinutes: number;
  /** A reading older than this still counts as a minimum, but not for the weighted forecast. */
  staleMinutes: number;
  warmup: { readings: number; spanMinutes: number; minElapsed: number; minUsed: number };
  recent: { lookbackMinutes: number; halfLifeMinutes: number };
  sustained: { lookbackHours: number; halfLifeHours: number };
}

export const DEFAULT_LIMITS: LimitsPolicy = {
  enabled: true,
  caution: { used: 0.75, projected: 1.0 },
  critical: { used: 0.9, projected: 1.5, exhaustMinutes: 30 },
  steps: { caution: 1, critical: 2 },
  exitProjected: 0.95,
  hysteresis: 0.05,
  confirmMinutes: 5,
  staleMinutes: 15,
  warmup: { readings: 3, spanMinutes: 60, minElapsed: 0.1, minUsed: 0.2 },
  recent: { lookbackMinutes: 60, halfLifeMinutes: 15 },
  sustained: { lookbackHours: 24, halfLifeHours: 6 },
};

/** `raw` checked against the defaults: a missing, mistyped or negative value keeps the default. */
export function limitsPolicy(raw: unknown): LimitsPolicy {
  return sanitize(DEFAULT_LIMITS, raw) as LimitsPolicy;
}

function sanitize(def: unknown, raw: unknown): unknown {
  if (isObject(def)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(def)) out[key] = sanitize(value, isObject(raw) ? raw[key] : undefined);
    return out;
  }
  if (typeof def === "number") return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : def;
  if (typeof def === "boolean") return typeof raw === "boolean" ? raw : def;
  return def;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** History keeps one sample per bucket (the latest). */
const BUCKET = 5 * MINUTE;
const KEEP = 7 * DAY;
/** An interval longer than this says nothing about the recent rate. */
const RECENT_GAP = 30 * MINUTE;
/** A reset time moving this much, or use dropping this much, is a new window. */
const ROLL_RESET = MINUTE;
const ROLL_DROP = 0.05;
/** Caution from the weighted forecast: exhaustion before this fraction of the time left. */
const CAUTION_HORIZON = 0.9;

/** The window's length: the source's, else by name (5h, 7d); undefined for a spend limit or an unknown window. */
export function windowLength(r: Pick<Reading, "window" | "lengthMs" | "spend">): number | undefined {
  if (r.lengthMs !== undefined && r.lengthMs > 0) return r.lengthMs;
  if (r.spend) return undefined;
  const w = r.window.toLowerCase();
  if (w === "5h" || w === "five_hour" || w === "primary") return 5 * HOUR;
  if (w.startsWith("7d") || w === "seven_day" || w === "secondary") return 7 * DAY;
  return undefined;
}

/** The name to show: Codex's primary/secondary by their length ("5h", "7d"), others as named. */
export function windowLabel(r: Pick<Reading, "window" | "lengthMs" | "spend">): string {
  if (r.window !== "primary" && r.window !== "secondary") return r.window;
  const len = windowLength(r);
  if (!len) return r.window;
  if (len % DAY === 0) return `${len / DAY}d`;
  if (len % HOUR === 0) return `${len / HOUR}h`;
  return `${Math.round(len / MINUTE)}m`;
}

interface Sample {
  at: number;
  used: number;
}

interface WindowState {
  latest: Reading;
  history: Sample[];
  tier: Tier;
  /** A higher tier the forecast wants, waiting for confirmation. */
  up?: { tier: Tier; since: number };
  /** A lower tier, waiting for confirmation. */
  down?: { tier: Tier; since: number };
}

interface Evaluation {
  wanted: Tier;
  immediate: Tier;
  held: (t: Tier) => boolean;
  view: Omit<WindowView, "tier" | "pending">;
  reason: string;
}

/** Readings of one provider's windows, their history, and each window's tier. */
export class Tracker {
  private windows = new Map<string, WindowState>();

  /** Adds a reading. Out-of-order readings are dropped; a new window (reset moved, use dropped) starts its history over. */
  record(reading: Reading): void {
    if (!Number.isFinite(reading.used) || !Number.isFinite(reading.at)) return;
    const st = this.windows.get(reading.window);
    if (!st) {
      this.windows.set(reading.window, { latest: reading, history: [{ at: reading.at, used: reading.used }], tier: "none" });
      return;
    }
    if (reading.at < st.latest.at) return;
    const prev = st.latest;
    const rolled =
      (prev.resetsAt !== undefined && reading.resetsAt !== undefined && Math.abs(reading.resetsAt - prev.resetsAt) > ROLL_RESET) ||
      reading.used <= prev.used - ROLL_DROP;
    if (rolled) {
      this.windows.set(reading.window, { latest: reading, history: [{ at: reading.at, used: reading.used }], tier: "none" });
      return;
    }
    st.latest = reading;
    // Use only grows within a window; a small drop (rounding) is not negative consumption.
    const used = Math.max(reading.used, st.history.at(-1)?.used ?? 0);
    const last = st.history.at(-1);
    if (last && Math.floor(last.at / BUCKET) === Math.floor(reading.at / BUCKET)) {
      last.at = reading.at;
      last.used = used;
    } else st.history.push({ at: reading.at, used });
    while (st.history.length > 1 && st.history[0]!.at < reading.at - KEEP) st.history.shift();
  }

  /** The latest reading of each window. */
  readings(): Reading[] {
    return [...this.windows.values()].map((s) => s.latest);
  }

  /** Forgets every window's tier (the source changed); readings stay. */
  clearTiers(): void {
    for (const st of this.windows.values()) {
      st.tier = "none";
      st.up = undefined;
      st.down = undefined;
    }
  }

  /**
   * The pressure now: the worst window's tier. Each call is an assessment that advances the
   * confirmations; `commit: false` looks without advancing (for status).
   */
  assess(now: number, policy: LimitsPolicy, commit = true): Pressure {
    if (!policy.enabled) return { tier: "none", steps: 0 };
    let worst: { tier: Tier; ev: Evaluation; st: WindowState } | undefined;
    for (const [name, original] of [...this.windows]) {
      if (original.latest.resetsAt !== undefined && original.latest.resetsAt <= now) {
        if (commit) this.windows.delete(name);
        continue;
      }
      const st = commit ? original : { ...original, up: original.up && { ...original.up }, down: original.down && { ...original.down } };
      const ev = evaluate(st, now, policy);
      advance(st, ev, now, policy);
      const better =
        !worst ||
        rank(st.tier) > rank(worst.tier) ||
        (rank(st.tier) === rank(worst.tier) && (ev.view.projected ?? ev.view.used) > (worst.ev.view.projected ?? worst.ev.view.used));
      if (better) worst = { tier: st.tier, ev, st };
    }
    if (!worst) return { tier: "none", steps: 0 };
    const { tier, ev } = worst;
    return {
      tier,
      steps: tier === "none" ? 0 : Math.round(policy.steps[tier]),
      window: ev.view.window,
      label: ev.view.label,
      used: ev.view.used,
      ...(ev.view.projected !== undefined ? { projected: ev.view.projected } : {}),
      ...(ev.view.exhaustsAt !== undefined ? { exhaustsAt: ev.view.exhaustsAt } : {}),
      warming: ev.view.warming,
      reason: tier === "none" ? "" : ev.reason,
    };
  }

  /** Every window as it stands, without advancing confirmations. */
  view(now: number, policy: LimitsPolicy): WindowView[] {
    const out: WindowView[] = [];
    for (const st of this.windows.values()) {
      if (st.latest.resetsAt !== undefined && st.latest.resetsAt <= now) continue;
      const ev = evaluate(st, now, policy);
      const pending = st.up?.tier ?? st.down?.tier;
      out.push({ ...ev.view, tier: st.tier, ...(pending !== undefined ? { pending } : {}) });
    }
    return out;
  }
}

function evaluate(st: WindowState, now: number, p: LimitsPolicy): Evaluation {
  const r = st.latest;
  const used = r.exhausted ? Math.max(1, r.used) : r.used;
  const len = windowLength(r);
  const remaining = r.resetsAt !== undefined ? r.resetsAt - now : undefined;
  const elapsed = len !== undefined && remaining !== undefined ? clamp(1 - remaining / len, 0, 1) : undefined;
  const ageMs = Math.max(0, now - r.at);
  let projected: number | undefined;
  let at90: number | undefined;
  let exhaustsAt: number | undefined;
  let warming = true;

  if (!r.spend && len !== undefined && remaining !== undefined && remaining > 0) {
    const h = st.history;
    const span = h.length ? h[h.length - 1]!.at - h[0]!.at : 0;
    const enough = h.length >= p.warmup.readings && span >= Math.min(p.warmup.spanMinutes * MINUTE, len / 10);
    const fresh = ageMs <= p.staleMinutes * MINUTE;
    const s = enough && fresh ? rate(h, now, p.sustained.lookbackHours * HOUR, p.sustained.halfLifeHours * HOUR) : undefined;
    if (s !== undefined) {
      warming = false;
      const recent = rate(h, now, p.recent.lookbackMinutes * MINUTE, p.recent.halfLifeMinutes * MINUTE, RECENT_GAP) ?? s;
      const tau = Math.min(HOUR, len / 5);
      const F = (t: number) => s * t + (recent - s) * tau * (1 - Math.exp(-t / tau));
      projected = used + F(remaining);
      at90 = used + F(CAUTION_HORIZON * remaining);
      if (used >= 1) exhaustsAt = now;
      else if (projected >= 1) {
        let lo = 0;
        let hi = remaining;
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (F(mid) >= 1 - used) hi = mid;
          else lo = mid;
        }
        exhaustsAt = now + hi;
      }
    } else if (elapsed !== undefined && elapsed >= p.warmup.minElapsed && used >= p.warmup.minUsed) {
      projected = used / elapsed;
      if (projected >= 1) exhaustsAt = used >= 1 ? now : now + ((1 - used) / used) * elapsed * len;
    }
  }

  const h = p.hysteresis;
  const soon =
    !warming && exhaustsAt !== undefined && exhaustsAt - now <= p.critical.exhaustMinutes * MINUTE && (r.resetsAt === undefined || exhaustsAt < r.resetsAt);
  const critNow = !!r.exhausted || used >= p.critical.used || soon;
  const critForecast = projected !== undefined && projected >= p.critical.projected;
  const cautNow = used >= p.caution.used;
  const cautForecast = projected !== undefined && (warming ? projected >= p.caution.projected : (at90 ?? 0) >= p.caution.projected);
  const wanted: Tier = critNow || critForecast ? "critical" : cautNow || cautForecast ? "caution" : "none";
  const immediate: Tier = critNow ? "critical" : cautNow ? "caution" : "none";
  const held = (t: Tier) => {
    if (t === "critical") return critNow || used >= p.critical.used - h || (projected !== undefined && projected > p.critical.projected - h);
    if (t === "caution") return used >= p.caution.used - h || (projected !== undefined && projected > p.exitProjected);
    return true;
  };
  const reason = r.exhausted
    ? "exhausted"
    : critNow && soon
      ? "runs out soon"
      : used >= p.caution.used
        ? "used"
        : warming
          ? "pace"
          : "forecast";
  return {
    wanted,
    immediate,
    held,
    reason,
    view: {
      window: r.window,
      label: windowLabel(r),
      used,
      ...(elapsed !== undefined ? { elapsed } : {}),
      ...(projected !== undefined ? { projected } : {}),
      ...(exhaustsAt !== undefined ? { exhaustsAt } : {}),
      ...(r.resetsAt !== undefined ? { resetsAt: r.resetsAt } : {}),
      ageMs,
      warming,
    },
  };
}

/** One assessment: immediate rises apply now; forecast rises and every fall need confirming. */
function advance(st: WindowState, ev: Evaluation, now: number, p: LimitsPolicy): void {
  const confirm = p.confirmMinutes * MINUTE;
  let cur = st.tier;
  if (rank(ev.immediate) > rank(cur)) cur = ev.immediate;
  if (rank(ev.wanted) > rank(cur)) {
    st.down = undefined;
    if (st.up) {
      const tier = minTier(st.up.tier, ev.wanted);
      if (now - st.up.since >= confirm) {
        cur = maxTier(cur, tier);
        st.up = rank(ev.wanted) > rank(cur) ? { tier: ev.wanted, since: now } : undefined;
      } else st.up = { tier, since: st.up.since };
    } else st.up = { tier: ev.wanted, since: now };
  } else if (rank(ev.wanted) === rank(cur) || ev.held(cur)) {
    st.up = undefined;
    st.down = undefined;
  } else {
    st.up = undefined;
    let target: Tier = ev.wanted;
    for (let i = rank(cur) - 1; i > rank(target); i--) if (ev.held(TIERS[i]!)) target = TIERS[i]!;
    if (st.down && now - st.down.since >= confirm) {
      cur = maxTier(target, st.down.tier);
      st.down = undefined;
    } else st.down = st.down ? { tier: maxTier(st.down.tier, target), since: st.down.since } : { tier: target, since: now };
  }
  if (cur !== st.tier) {
    st.tier = cur;
    if (st.up && rank(st.up.tier) <= rank(cur)) st.up = undefined;
  }
}

const minTier = (a: Tier, b: Tier) => (rank(a) <= rank(b) ? a : b);
const maxTier = (a: Tier, b: Tier) => (rank(a) >= rank(b) ? a : b);

/** Time- and recency-weighted average rate (fraction per ms) of the history's intervals within `lookback`. */
function rate(h: readonly Sample[], now: number, lookback: number, halfLife: number, maxGap?: number): number | undefined {
  const start = now - lookback;
  let num = 0;
  let den = 0;
  for (let i = 1; i < h.length; i++) {
    const a = h[i - 1]!;
    const b = h[i]!;
    if (b.at <= start) continue;
    const dt = b.at - a.at;
    if (dt <= 0 || (maxGap !== undefined && dt > maxGap)) continue;
    const from = Math.max(a.at, start);
    const w = (b.at - from) * Math.pow(2, -(now - (from + b.at) / 2) / halfLife);
    num += w * (Math.max(0, b.used - a.used) / dt);
    den += w;
  }
  return den > 0 ? num / den : undefined;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** The effort to apply: `steps` below the baseline along `levels`, never below the floor. Unmanaged levels pass. */
export function applyLimit(baseline: string, pressure: Pick<Pressure, "steps">, floor: string, levels: readonly string[]): { level: string; limited: boolean } {
  const b = levels.indexOf(baseline);
  const f = levels.indexOf(floor);
  if (b < 0 || f < 0 || b <= f || pressure.steps <= 0) return { level: baseline, limited: false };
  const level = levels[Math.max(f, b - pressure.steps)]!;
  return { level, limited: level !== baseline };
}

// Parsers. Each is pure and ignores what it does not recognize.

type HeaderMap = Record<string, string | undefined>;

function lower(headers: HeaderMap): HeaderMap {
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Anthropic's unified subscription headers: `anthropic-ratelimit-unified-<w>-utilization` (0-1), `-reset` (epoch s), `-status`. */
export function readAnthropicHeaders(headers: HeaderMap, now: number): Reading[] {
  const h = lower(headers);
  const out: Reading[] = [];
  for (const key of Object.keys(h)) {
    const m = /^anthropic-ratelimit-unified-(.+)-utilization$/.exec(key);
    if (!m) continue;
    const w = m[1]!;
    const used = num(h[key]);
    if (used === undefined) continue;
    const reset = num(h[`anthropic-ratelimit-unified-${w}-reset`]);
    const status = h[`anthropic-ratelimit-unified-${w}-status`]?.toLowerCase();
    const exhausted = status === "rejected" || status === "exceeded";
    out.push({
      window: w,
      used: exhausted ? Math.max(1, used) : used,
      at: now,
      ...(reset !== undefined ? { resetsAt: reset * 1000 } : {}),
      ...(exhausted ? { exhausted } : {}),
    });
  }
  return out;
}

/** Codex's SSE headers: `x-codex-{primary,secondary}-used-percent`, `-window-minutes`, `-reset-at` (s) or `-reset-after-seconds`. */
export function readCodexHeaders(headers: HeaderMap, now: number): Reading[] {
  const h = lower(headers);
  const out: Reading[] = [];
  for (const w of ["primary", "secondary"]) {
    const pct = num(h[`x-codex-${w}-used-percent`]);
    if (pct === undefined) continue;
    const minutes = num(h[`x-codex-${w}-window-minutes`]);
    const at = num(h[`x-codex-${w}-reset-at`]);
    const after = num(h[`x-codex-${w}-reset-after-seconds`]);
    const resetsAt = at !== undefined ? at * 1000 : after !== undefined ? now + after * 1000 : undefined;
    out.push({
      window: w,
      used: pct / 100,
      at: now,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(minutes !== undefined && minutes > 0 ? { lengthMs: minutes * MINUTE } : {}),
    });
  }
  return out;
}

/** ChatGPT's `GET /backend-api/wham/usage`: `rate_limit.{primary,secondary}_window`. Named pools are ignored. */
export function readCodexUsage(json: unknown, now: number): Reading[] {
  const limit = isObject(json) && isObject(json.rate_limit) ? json.rate_limit : undefined;
  if (!limit) return [];
  const out: Reading[] = [];
  for (const w of ["primary", "secondary"]) {
    const win = limit[`${w}_window`];
    if (!isObject(win)) continue;
    const pct = num(win.used_percent);
    if (pct === undefined) continue;
    const at = num(win.reset_at);
    const after = num(win.reset_after_seconds);
    const seconds = num(win.limit_window_seconds);
    const resetsAt = at !== undefined ? at * 1000 : after !== undefined ? now + after * 1000 : undefined;
    out.push({
      window: w,
      used: pct / 100,
      at: now,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(seconds !== undefined && seconds > 0 ? { lengthMs: seconds * 1000 } : {}),
    });
  }
  return out;
}

/** Claude Code's `rateLimits`: `{ kind, percentUsed (0-100), resetsAt (ISO) }`. */
export function readClaudeCodeLimits(rateLimits: unknown, now: number): Reading[] {
  if (!Array.isArray(rateLimits)) return [];
  const out: Reading[] = [];
  for (const item of rateLimits) {
    if (!isObject(item) || typeof item.kind !== "string") continue;
    const pct = num(item.percentUsed);
    if (pct === undefined) continue;
    const reset = typeof item.resetsAt === "string" ? Date.parse(item.resetsAt) : NaN;
    const spend = item.kind === "spend_limit";
    out.push({
      window: item.kind,
      used: pct / 100,
      at: now,
      ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
      ...(spend ? { spend } : {}),
    });
  }
  return out;
}

/** One status line per window: used, elapsed, projected, exhaustion, age, tier. */
export function describeWindows(views: readonly WindowView[], now: number): string[] {
  return views.map((v) => {
    const parts = [`${v.label}: ${pct(v.used)} used`];
    if (v.elapsed !== undefined) parts.push(`${pct(v.elapsed)} of the window elapsed`);
    if (v.projected !== undefined) parts.push(`projected ${pct(v.projected)} at reset${v.warming ? " (linear pace, warming up)" : ""}`);
    if (v.exhaustsAt !== undefined) parts.push(`runs out in ${duration(v.exhaustsAt - now)}`);
    parts.push(`reading ${duration(v.ageMs)} old`);
    parts.push(`tier ${v.tier}${v.pending ? ` (${v.pending} pending confirmation)` : ""}`);
    return parts.join(", ");
  });
}

/** `5h 84%`: the limiting window for the status line. */
export function pressureLabel(p: Pressure): string {
  return `${p.label ?? p.window ?? "?"} ${pct(p.used ?? 0)}`;
}

/** A tier-change notice. */
export function pressureNotice(p: Pressure, now: number): string {
  if (p.tier === "none") return "auto-effort: usage limit lifted; effort back to normal";
  const parts = [`${p.label ?? p.window} window ${pct(p.used ?? 0)} used`];
  if (p.projected !== undefined) parts.push(`projected ${pct(p.projected)} at reset`);
  const tail = p.exhaustsAt !== undefined && p.exhaustsAt > now ? ` (runs out in ~${duration(p.exhaustsAt - now)})` : "";
  return `auto-effort: ${parts.join(", ")}${tail}; effort lowered ${p.steps === 1 ? "one level" : `${p.steps} levels`}`;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / MINUTE));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.round(m / (24 * 60))}d`;
}
