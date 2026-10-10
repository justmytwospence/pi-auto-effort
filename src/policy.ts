/** Thinking levels auto-effort moves between, lowest first; the index is the effort score. */
export const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

export interface Policy {
  /** Lowest level auto-effort sets. */
  floor: Level;
  /** Weight of the newest score in the running average (1 = no smoothing). */
  alpha: number;
  /** The average must differ from the current level by this much to move. */
  margin: number;
  /** A single score this far above the current level jumps straight to it... */
  jump: number;
  /** ...when Jev is at least this confident. */
  jumpConfidence: number;
  /** Assessments (messages, and mid-run checks) a level must hold before it can go down. */
  minDwell: number;
  /** A go-ahead message ("yes", "continue") above this probability keeps the level. */
  ackThreshold: number;
}

export const DEFAULT_POLICY: Policy = {
  floor: "low",
  alpha: 0.5,
  margin: 0.6,
  jump: 1.5,
  jumpConfidence: 0.6,
  minDwell: 2,
  ackThreshold: 0.7,
};

export interface EffortState {
  /** Running average of depth scores; undefined before the first judgment. */
  e?: number;
  /** Assessments since the level last changed. */
  dwell: number;
  /** The highest level auto-effort may set: your latest manual choice. */
  ceiling: string;
}

export interface Judgment {
  /** Depth score 0-3. */
  score: number;
  confidence: number;
  /** Probability the message is a go-ahead relying on the earlier plan. */
  ack: number;
}

export function levelIndex(level: string): number {
  return LEVELS.indexOf(level as Level);
}

export interface Decision {
  level: string;
  state: EffortState;
  reason: "ack" | "jump" | "up" | "down" | "hold" | "unavailable";
}

/**
 * The next level for a message. `current` is the session's level now. Levels outside the managed
 * range (off, minimal), or a ceiling below the floor, are left alone.
 */
export function decide(current: string, state: EffortState, judgment: Judgment | undefined, policy: Policy): Decision {
  const floor = levelIndex(policy.floor);
  const ceiling = levelIndex(state.ceiling);
  const c = levelIndex(current);
  if (c < 0 || ceiling < 0 || ceiling < floor) return { level: current, state: { ...state, dwell: state.dwell + 1 }, reason: "hold" };
  if (!judgment) return { level: current, state: { ...state, dwell: state.dwell + 1 }, reason: "unavailable" };
  const s = judgment.score;
  // A go-ahead's own score says nothing about the work it approves, so it leaves the average alone.
  if (judgment.ack > policy.ackThreshold) return { level: current, state: { ...state, dwell: state.dwell + 1 }, reason: "ack" };
  let e = state.e === undefined ? s : policy.alpha * s + (1 - policy.alpha) * state.e;
  let target = c;
  let reason: Decision["reason"] = "hold";
  if (s - c >= policy.jump && judgment.confidence >= policy.jumpConfidence) {
    target = Math.round(s);
    reason = "jump";
    // Lift the average with the jump so it does not pull the level straight back down.
    e = Math.max(e, s);
  } else if (e - c >= policy.margin) {
    target = Math.round(e);
    reason = "up";
  } else if (c - e >= policy.margin && state.dwell >= policy.minDwell) {
    target = Math.round(e);
    reason = "down";
  }
  target = Math.min(Math.max(target, floor), ceiling);
  const level = LEVELS[target] as string;
  if (target === c) return { level: current, state: { ...state, e, dwell: state.dwell + 1 }, reason: "hold" };
  return { level, state: { ...state, e, dwell: 0 }, reason };
}

/**
 * Where the level is heading: "up" or "down" when the running average sits at least half the
 * margin away from `level` and the bounds leave room to move that way, else undefined.
 */
export function trend(level: string, state: EffortState, policy: Policy): "up" | "down" | undefined {
  const c = levelIndex(level);
  const ceiling = levelIndex(state.ceiling);
  const floor = levelIndex(policy.floor);
  if (state.e === undefined || c < 0 || ceiling < 0) return undefined;
  const threshold = policy.margin / 2;
  if (state.e - c >= threshold && c < ceiling) return "up";
  if (c - state.e >= threshold && c > floor) return "down";
  return undefined;
}
