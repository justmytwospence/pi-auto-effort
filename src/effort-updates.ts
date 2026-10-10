// Cache-safe effort changes on OpenAI Responses models that take `configuration_update` input
// items (GPT-6 Astra and GPT-6.1 Sol through the Codex subscription backend, verified live): the
// request-level `reasoning.effort` stays at the conversation's first value, and each later change
// is an item at the point in the input where it happened, replayed there on every later request.
// Changing `reasoning.effort` itself would start a separate prompt cache for the new value.
//
// Wire rules (checked against the Codex backend): an item is accepted before a user message or
// after a tool result; two adjacent items are rejected; its effort is validated against the model
// like the request-level one. A rewritten history (compaction, branch switch) resets the baseline.
import { createHash } from "node:crypto";

export interface EffortUpdatesConfig {
  enabled: boolean;
  /** `provider/id` globs of models whose backend accepts `configuration_update` items. */
  models: string[];
}

export const DEFAULT_EFFORT_UPDATES: EffortUpdatesConfig = {
  enabled: true,
  models: ["openai-codex/gpt-6-astra", "openai-codex/gpt-6.1-sol"],
};

/** Efforts both verified models accept. */
const WIRE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface Transition {
  /** Position in the input the item goes in front of (before any other item is spliced in). */
  index: number;
  /** Fingerprint of `input[index - 1]` when recorded; a mismatch means the history was rewritten. */
  anchor: string;
  effort: string;
}

export interface EffortUpdatesState {
  /** The request-level effort for this conversation. */
  base?: string;
  /** The effort in force after the last request. */
  current?: string;
  transitions: Transition[];
}

export const emptyState = (): EffortUpdatesState => ({ transitions: [] });

type Item = Record<string, unknown>;

/** Fingerprint of the item before `index`, without output-only fields a replay may drop. */
export function anchorAt(input: readonly unknown[], index: number): string {
  if (index <= 0) return "";
  const item = input[index - 1];
  if (!item || typeof item !== "object") return "";
  const { id: _id, status: _status, ...stable } = item as Item;
  return createHash("sha1").update(JSON.stringify(stable)).digest("hex");
}

function isUserMessage(item: unknown): boolean {
  return Boolean(item && typeof item === "object" && (item as Item).role === "user");
}

export interface Plan {
  input: unknown[];
  /** The request-level effort to send. */
  effort: string;
  /** Whether the recorded state changed (worth persisting). */
  changed: boolean;
}

/**
 * Pins the request-level effort and splices the recorded updates into a copy of `input`.
 * `requested` is the effort Pi would send at the request level. Mutates `state`.
 */
export function plan(state: EffortUpdatesState, input: readonly unknown[], requested: string): Plan {
  let changed = false;
  if (state.transitions.some((t) => t.index > input.length || t.anchor !== anchorAt(input, t.index))) {
    state.base = undefined;
    state.current = undefined;
    state.transitions = [];
    changed = true;
  }
  if (state.base === undefined) {
    state.base = requested;
    state.current = requested;
    return { input: [...input], effort: requested, changed: true };
  }
  if (state.current !== requested) {
    // Before the user message a new prompt adds, else after the latest item (a tool result).
    const index = isUserMessage(input.at(-1)) ? input.length - 1 : input.length;
    const before = state.transitions.filter((t) => t.index < index).at(-1)?.effort ?? state.base;
    const at = state.transitions.findIndex((t) => t.index === index);
    if (at >= 0) state.transitions.splice(at, 1);
    // A change back to the effort already in force there needs no item.
    if (requested !== before) state.transitions.push({ index, anchor: anchorAt(input, index), effort: requested });
    state.transitions.sort((a, b) => a.index - b.index);
    state.current = requested;
    changed = true;
  }
  const next = [...input];
  state.transitions.forEach((t, offset) => next.splice(t.index + offset, 0, { type: "configuration_update", reasoning: { effort: t.effort } }));
  return { input: next, effort: state.base, changed };
}

interface Payload {
  model?: unknown;
  input?: unknown;
  reasoning?: { effort?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

/** Rewrites a Responses payload in place; returns whether the state changed. Leaves other payloads alone. */
export function rewritePayload(state: EffortUpdatesState, payload: unknown): boolean {
  const p = payload as Payload | undefined;
  if (!p || typeof p !== "object" || !Array.isArray(p.input) || !p.reasoning || typeof p.reasoning.effort !== "string") return false;
  if (!WIRE_EFFORTS.has(p.reasoning.effort)) return false;
  // Pi never sends these items itself; a payload that already has them belongs to someone else.
  if (p.input.some((item) => (item as Item | undefined)?.type === "configuration_update")) return false;
  const result = plan(state, p.input, p.reasoning.effort);
  p.input = result.input;
  p.reasoning = { ...p.reasoning, effort: result.effort };
  return result.changed;
}

/** Restores a saved state, or an empty one when the data is not a valid state. */
export function restoreState(data: unknown): EffortUpdatesState {
  const d = data as Partial<EffortUpdatesState> | undefined;
  if (!d || typeof d !== "object" || !Array.isArray(d.transitions)) return emptyState();
  const transitions = d.transitions.filter(
    (t): t is Transition => Boolean(t) && Number.isInteger(t.index) && typeof t.anchor === "string" && typeof t.effort === "string" && WIRE_EFFORTS.has(t.effort),
  );
  return {
    ...(typeof d.base === "string" ? { base: d.base } : {}),
    ...(typeof d.current === "string" ? { current: d.current } : {}),
    transitions,
  };
}
