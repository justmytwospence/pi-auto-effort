// pi-auto-effort: sets the thinking level for each message you send. Jev, through Pi's own
// classifier models, rates how demanding the request is (0-3); a running average with a margin,
// a jump rule for clearly harder work, and a minimum dwell before going down keep the level from
// flip-flopping. Your latest manual level is the ceiling. During a run (tool follow-ups) the level
// is re-assessed only on models that keep their prompt cache across an effort change
// (midrun.ts); on Codex GPT-6 models that means configuration_update items (effort-updates.ts).
// When a subscription window (Anthropic 5h/7d, Codex primary/secondary) is on track to run out
// before it resets, the level goes one or two below the one the policy picked (limits.ts); the
// policy's own baseline is kept apart, so the cut never feeds back into it.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { type ClassifierQuestion, type JevConfig, type JevOutcome, askJev, bool, score } from "./jev.ts";
import {
  DEFAULT_LIMITS,
  type LimitsPolicy,
  type Pressure,
  Tracker,
  applyLimit,
  describeWindows,
  limitsPolicy,
  pressureLabel,
  pressureNotice,
  readAnthropicHeaders,
  readCodexHeaders,
} from "./limits.ts";
import { DEFAULT_EFFORT_UPDATES, type EffortUpdatesConfig, emptyState, restoreState, rewritePayload } from "./effort-updates.ts";
import { DEFAULT_MID_RUN, MID_RUN_QUESTIONS, type MidRunConfig, globMatch, midRunSupported, runState, shouldAssess } from "./midrun.ts";
import { DEFAULT_POLICY, type EffortState, type Judgment, LEVELS, type Policy, decide, trend } from "./policy.ts";
import { clip, messageText } from "./transcript.ts";
import { CodexPoller } from "./usage.ts";

export interface EffortConfig extends Record<string, unknown> {
  enabled: boolean;
  jev: JevConfig;
  policy: Policy;
  limits: LimitsPolicy;
  midRun: MidRunConfig;
  effortUpdates: EffortUpdatesConfig;
}

export const DEFAULT_CONFIG: EffortConfig = {
  enabled: true,
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 1_500 },
  policy: DEFAULT_POLICY,
  limits: DEFAULT_LIMITS,
  midRun: DEFAULT_MID_RUN,
  effortUpdates: DEFAULT_EFFORT_UPDATES,
};

/** Effort-update settings with invalid values replaced by their defaults. */
export function effortUpdatesConfig(value: unknown): EffortUpdatesConfig {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof EffortUpdatesConfig, unknown>>;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_EFFORT_UPDATES.enabled,
    models: Array.isArray(v.models) ? v.models.filter((m): m is string => typeof m === "string") : DEFAULT_EFFORT_UPDATES.models,
  };
}

/** The `provider/id` globs whose effort changes keep the cache through `configuration_update` items. */
function updateModels(config: EffortConfig): string[] {
  const updates = effortUpdatesConfig(config.effortUpdates);
  return updates.enabled ? updates.models : [];
}

/** Mid-run settings with invalid values replaced by their defaults. */
export function midRunConfig(value: unknown): MidRunConfig {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof MidRunConfig, unknown>>;
  const count = (x: unknown, d: number) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : d);
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_MID_RUN.enabled,
    everyTurns: Math.max(1, count(v.everyTurns, DEFAULT_MID_RUN.everyTurns)),
    errorTurns: count(v.errorTurns, DEFAULT_MID_RUN.errorTurns),
    steps: Math.max(1, count(v.steps, DEFAULT_MID_RUN.steps)),
    models: Array.isArray(v.models) ? v.models.filter((m): m is string => typeof m === "string") : DEFAULT_MID_RUN.models,
  };
}

/** For tests: the clock and fetch the limits stage uses. */
export interface AutoEffortDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Abort a Codex usage request after this long (default 5 s). */
  codexTimeoutMs?: number;
}

const NO_PRESSURE: Pressure = { tier: "none", steps: 0 };

const STATE_ENTRY = "auto-effort:state";
const UPDATES_ENTRY = "auto-effort:effort-updates";
const STATUS_KEY = "auto-effort";

export const QUESTIONS: Record<string, ClassifierQuestion> = {
  depth: {
    type: "score",
    instructions:
      "How much careful reasoning does the work asked for in `request` need from a coding agent, given `previous_requests`, `last_outcome` and `signals`?",
    criteria: [
      "A lookup, a trivial answer, or a mechanical change",
      "A routine single-file change or a clear question",
      "A multi-step change, debugging with clear symptoms, or design inside a known pattern",
      "Subtle design, a cross-cutting refactor, hard debugging, or correctness-critical work",
    ],
  },
  ack: {
    type: "bool",
    instructions:
      'Is `request` a short go-ahead or acknowledgement (like "yes", "go ahead", "continue", "do it") that relies on the plan already discussed, rather than a new task?',
    criteria: { true: "A go-ahead for work already under way", false: "A new or changed request" },
  },
};

interface Entry {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean; [key: string]: unknown };
}

/** The Jev state for a new prompt: the request, the two before it, the last answer, and what the last run did. */
export function effortState(prompt: string, entries: readonly unknown[]): Record<string, unknown> {
  const list = entries as Entry[];
  const users: number[] = [];
  list.forEach((entry, i) => {
    if (entry.type === "message" && entry.message?.role === "user") users.push(i);
  });
  // The new prompt may already be on the branch; the previous run is before it.
  const lastUser = users.at(-1);
  if (lastUser !== undefined && messageText(list[lastUser]?.message?.content).trim() === prompt.trim()) users.pop();
  const runStart = users.at(-1);
  const previous = users.slice(-2).map((i) => clip(messageText(list[i]?.message?.content).trim(), 1_000));
  let lastOutcome = "";
  const signals = { last_run_errors: 0, files_edited: 0, tool_calls: 0 };
  if (runStart !== undefined) {
    for (const entry of list.slice(runStart + 1)) {
      const m = entry.message;
      if (entry.type !== "message" || !m) continue;
      if (m.role === "user") break;
      if (m.role === "assistant") {
        const text = messageText(m.content).trim();
        if (text) lastOutcome = text;
        const calls = Array.isArray(m.content) ? m.content.filter((b: { type?: string }) => b?.type === "toolCall") : [];
        signals.tool_calls += calls.length;
      }
      if (m.role === "toolResult") {
        if (m.isError) signals.last_run_errors++;
        if ((m.toolName === "edit" || m.toolName === "write") && !m.isError) signals.files_edited++;
      }
    }
  }
  return {
    request: clip(prompt, 8_000),
    previous_requests: previous.length ? previous : ["(none: this is the first request)"],
    last_outcome: lastOutcome ? clip(lastOutcome, 1_500) : "(none)",
    signals,
  };
}

/** True when the process was started with an explicit `--thinking` level (for example a subagent). */
export function thinkingPinned(argv: readonly string[] = process.argv): boolean {
  return argv.some((a) => a === "--thinking" || a.startsWith("--thinking="));
}

export default function autoEffort(pi: ExtensionAPI, deps: AutoEffortDeps = {}) {
  const now = deps.now ?? Date.now;
  let config: EffortConfig = DEFAULT_CONFIG;
  let state: EffortState = { dwell: DEFAULT_POLICY.minDwell, ceiling: "high" };
  // The level the policy picked last, before any limit, and the level actually applied.
  let baseline: string | undefined;
  let appliedLevel: string | undefined;
  let pressure: Pressure = NO_PRESSURE;
  let pressureProvider: string | undefined;
  const trackers = new Map<string, Tracker>();
  const tracker = (provider: string) => {
    let t = trackers.get(provider);
    if (!t) trackers.set(provider, (t = new Tracker()));
    return t;
  };
  let latestCtx: ExtensionContext | undefined;
  const poller = new CodexPoller({
    fetch: deps.fetch ?? ((...args) => fetch(...args)),
    now,
    timeoutMs: deps.codexTimeoutMs ?? 5_000,
    token: async () => latestCtx?.modelRegistry.getApiKeyForProvider("openai-codex"),
    onAccount: () => trackers.set("openai-codex", new Tracker()),
    record: (readings) => readings.forEach((r) => tracker("openai-codex").record(r)),
  });
  let sessionOn = true;
  let applying = false;
  // Our own setThinkingLevel calls also emit thinking_level_select, during or just after the call.
  let ownLevel: string | undefined;
  let firedWhileApplying = false;
  let lastReason = "";
  // Tool turns since the last assessment in this run.
  let turnsSince = 0;
  // Request-level effort and configuration_update positions for this conversation.
  let updates = emptyState();
  const pinned = thinkingPinned();

  const active = () => sessionOn && config.enabled && !pinned;

  const limits = () => limitsPolicy(config.limits);
  const limitsOn = () => active() && limits().enabled;

  const status = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const limited = limitsOn() && pressure.tier !== "none" ? `, limited: ${pressureLabel(pressure)}` : "";
    // The trend is measured on the policy's own pick, before any limit cut.
    const current = pi.getThinkingLevel();
    const base = baseline !== undefined && appliedLevel !== undefined && current === appliedLevel ? baseline : current;
    const direction = trend(base, state, config.policy);
    const arrow = direction === "up" ? "↑" : direction === "down" ? "↓" : "→";
    ctx.ui.setStatus(STATUS_KEY, active() ? `effort: ${current} (auto ${arrow}${limited})` : undefined);
  };

  const manual = (level: string) => {
    state = { ...state, ceiling: level, dwell: config.policy.minDwell };
    baseline = level;
    appliedLevel = level;
  };

  /** Refreshes Codex usage in the background while a Codex model is in use. */
  const pollCodex = (ctx: ExtensionContext) => {
    latestCtx = ctx;
    if (limitsOn() && ctx.model?.provider === "openai-codex") void poller.refresh();
  };

  const limitLines = (ctx: ExtensionContext) => {
    const provider = ctx.model?.provider;
    const views = provider ? trackers.get(provider)?.view(now(), limits()) ?? [] : [];
    if (!limits().enabled) return ["limits: off (settings)"];
    if (!views.length) return [`limits: no readings for ${provider ?? "this model"} yet`];
    return describeWindows(views, now()).map((line) => `limits: ${line}`);
  };

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig("auto-effort", DEFAULT_CONFIG, ctx.cwd);
    const saved = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((e) => (e as Entry).type === "custom" && (e as Entry).customType === STATE_ENTRY) as Entry | undefined;
    const data = saved?.data as (Partial<EffortState> & { baseline?: unknown; level?: unknown }) | undefined;
    state =
      data && typeof data.ceiling === "string"
        ? { e: typeof data.e === "number" ? data.e : undefined, dwell: typeof data.dwell === "number" ? data.dwell : config.policy.minDwell, ceiling: data.ceiling }
        : { dwell: config.policy.minDwell, ceiling: pi.getThinkingLevel() };
    // An entry from before the limits stage has no baseline: its level was the baseline.
    appliedLevel = data && typeof data.level === "string" ? data.level : undefined;
    baseline = data && typeof data.baseline === "string" ? data.baseline : appliedLevel;
    pressure = NO_PRESSURE;
    const savedUpdates = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((e) => (e as Entry).type === "custom" && (e as Entry).customType === UPDATES_ENTRY) as Entry | undefined;
    updates = restoreState(savedUpdates?.data);
    status(ctx);
    pollCodex(ctx);
  });

  // On models that take configuration_update items, any effort change (auto, manual, or another
  // extension's) keeps the prompt cache: the request-level effort stays put and the change
  // becomes an item in the input. Independent of /auto-effort on/off.
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model || (event.payload as { model?: unknown } | undefined)?.model !== model.id) return undefined;
    const key = `${model.provider}/${model.id}`;
    if (!updateModels(config).some((glob) => globMatch(glob, key))) return undefined;
    if (rewritePayload(updates, event.payload)) pi.appendEntry(UPDATES_ENTRY, { ...updates, transitions: [...updates.transitions] });
    return event.payload;
  });

  pi.on("model_select", (_event, ctx) => pollCodex(ctx));
  pi.on("agent_settled", (_event, ctx) => pollCodex(ctx));

  pi.on("after_provider_response", (event, ctx) => {
    const provider = ctx.model?.provider;
    const headers = event.headers ?? {};
    if (provider === "anthropic") readAnthropicHeaders(headers, now()).forEach((r) => tracker(provider).record(r));
    else if (provider === "openai-codex") readCodexHeaders(headers, now()).forEach((r) => tracker(provider).record(r));
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const own = applying || (ownLevel !== undefined && event.level === ownLevel);
    ownLevel = undefined;
    if (applying) firedWhileApplying = true;
    if (own) return;
    manual(event.level);
    if (ctx) status(ctx);
  });

  /**
   * Applies a judgment: the policy picks a level from its own last pick, the limits stage may cut
   * it, and the decision is recorded. `phase` is "prompt" before a message you send, "run" between
   * tool turns.
   */
  const settle = (ctx: ExtensionContext, outcome: JevOutcome, judgment: Judgment | undefined, extra: Record<string, unknown>) => {
    const current = pi.getThinkingLevel();
    // The policy works from its own last pick; a level someone else set since replaces it.
    const base = baseline !== undefined && appliedLevel !== undefined && current === appliedLevel ? baseline : current;
    const decision = decide(base, state, judgment, config.policy);
    state = decision.state;
    baseline = decision.level;
    lastReason = outcome.ok ? decision.reason : `unavailable: ${outcome.reason}`;

    const provider = ctx.model?.provider;
    if (provider !== pressureProvider) {
      if (pressureProvider) trackers.get(pressureProvider)?.clearTiers();
      pressureProvider = provider;
    }
    const previous = pressure;
    pressure = limitsOn() && provider ? (trackers.get(provider)?.assess(now(), limits()) ?? NO_PRESSURE) : NO_PRESSURE;
    const target = applyLimit(baseline, pressure, config.policy.floor, LEVELS).level;
    if (pressure.tier !== previous.tier && ctx.hasUI) ctx.ui.notify(pressureNotice(pressure, now()), pressure.tier === "none" ? "info" : "warning");

    if (target !== current) {
      applying = true;
      firedWhileApplying = false;
      try {
        pi.setThinkingLevel(target as never);
      } finally {
        applying = false;
      }
      if (!firedWhileApplying) ownLevel = pi.getThinkingLevel();
    }
    appliedLevel = pi.getThinkingLevel();
    pi.appendEntry(STATE_ENTRY, {
      ...state,
      ...extra,
      baseline,
      from: current,
      level: appliedLevel,
      reason: lastReason,
      ...(pressure.tier !== "none"
        ? { limit: { tier: pressure.tier, steps: pressure.steps, window: pressure.window, used: pressure.used, projected: pressure.projected, exhaustsAt: pressure.exhaustsAt } }
        : {}),
      ...(judgment ? { score: judgment.score, confidence: judgment.confidence, ack: judgment.ack } : {}),
      ...(outcome.ok ? { latencyMs: outcome.latencyMs, inputTokens: outcome.usage?.input } : {}),
    });
    status(ctx);
  };

  pi.on("before_agent_start", async (event, ctx) => {
    config = loadConfig("auto-effort", DEFAULT_CONFIG, ctx.cwd);
    turnsSince = 0;
    if (!active() || !event.prompt.trim()) return;
    // Codex usage refreshes alongside the Jev call; the prompt never waits for it.
    pollCodex(ctx);
    const outcome = await askJev(ctx.modelRegistry, config.jev, effortState(event.prompt, ctx.sessionManager.getBranch()), QUESTIONS, ctx.signal);
    const depth = outcome.ok ? score(outcome.answers, "depth") : undefined;
    const ack = outcome.ok ? bool(outcome.answers, "ack") : undefined;
    const judgment = depth && ack !== undefined ? { score: depth.score, confidence: depth.confidence, ack } : undefined;
    settle(ctx, outcome, judgment, { phase: "prompt" });
  });

  // Between tool turns, on models that take an effort change mid-conversation without losing the
  // cache: the handler is awaited before the next request, which picks up the new level.
  pi.on("turn_end", async (event, ctx) => {
    if (!active()) return;
    const mid = midRunConfig(config.midRun);
    if (!mid.enabled || !midRunSupported(ctx.model, [...mid.models, ...updateModels(config)])) return;
    const results = (event.toolResults ?? []) as Array<{ isError?: boolean }>;
    const stop = (event.message as { stopReason?: string } | undefined)?.stopReason;
    // A turn without tool results ends the run; an error or abort has no next request to change.
    if (!results.length || stop === "error" || stop === "aborted" || ctx.signal?.aborted) return;
    turnsSince++;
    if (!shouldAssess(mid, turnsSince, results.filter((r) => r.isError).length)) return;
    turnsSince = 0;
    const outcome = await askJev(ctx.modelRegistry, config.jev, runState(ctx.sessionManager.getBranch(), mid.steps), MID_RUN_QUESTIONS, ctx.signal);
    if (ctx.signal?.aborted) return;
    const depth = outcome.ok ? score(outcome.answers, "depth") : undefined;
    // Mid-run there is no message to be a go-ahead.
    const judgment = depth ? { score: depth.score, confidence: depth.confidence, ack: 0 } : undefined;
    settle(ctx, outcome, judgment, { phase: "run", turn: event.turnIndex });
  });

  pi.registerCommand("auto-effort", {
    description: "auto-effort: status, limits, on, or off (this session)",
    getArgumentCompletions: (prefix: string) =>
      ["status", "limits", "on", "off"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "on" || arg === "off") {
        sessionOn = arg === "on";
        if (!sessionOn && levelDiffers(pi.getThinkingLevel(), state.ceiling)) {
          applying = true;
          try {
            pi.setThinkingLevel(state.ceiling as never);
          } finally {
            applying = false;
          }
        }
        status(ctx);
        ctx.ui.notify(`auto-effort ${arg} for this session${sessionOn ? "" : `; back to ${pi.getThinkingLevel()}`}`, "info");
        return;
      }
      if (arg === "limits") {
        ctx.ui.notify(limitLines(ctx).join("\n"), "info");
        return;
      }
      ctx.ui.notify(
        [
          `auto-effort ${active() ? "on" : pinned ? "off (--thinking was given)" : "off"}: ${pi.getThinkingLevel()} now, ceiling ${state.ceiling} (your last manual level), floor ${config.policy.floor}.`,
          `Running average ${state.e === undefined ? "-" : state.e.toFixed(2)}, ${state.dwell} assessment${state.dwell === 1 ? "" : "s"} at this level${lastReason ? `, last decision: ${lastReason}` : ""}.`,
          ...(baseline !== undefined && baseline !== appliedLevel ? [`Without the limit: ${baseline}.`] : []),
          ...limitLines(ctx),
        ].join("\n"),
        "info",
      );
    },
  });
}

function levelDiffers(a: string, b: string) {
  return a !== b;
}
