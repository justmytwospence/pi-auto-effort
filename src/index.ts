// pi-auto-effort: sets the thinking level once per message you send. Jev, through Pi's own
// classifier models, rates how demanding the request is (0-3); a running average with a margin,
// a jump rule for clearly harder work, and a minimum dwell before going down keep the level from
// flip-flopping. Your latest manual level is the ceiling. The level never changes during a run
// (tool follow-ups), so prompt caches survive.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { type ClassifierQuestion, type JevConfig, askJev, bool, score } from "./jev.ts";
import { DEFAULT_POLICY, type EffortState, type Policy, decide } from "./policy.ts";
import { clip, messageText } from "./transcript.ts";

export interface EffortConfig extends Record<string, unknown> {
  enabled: boolean;
  jev: JevConfig;
  policy: Policy;
}

export const DEFAULT_CONFIG: EffortConfig = {
  enabled: true,
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 1_500 },
  policy: DEFAULT_POLICY,
};

const STATE_ENTRY = "auto-effort:state";
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

export default function autoEffort(pi: ExtensionAPI) {
  let config: EffortConfig = DEFAULT_CONFIG;
  let state: EffortState = { dwell: DEFAULT_POLICY.minDwell, ceiling: "high" };
  let sessionOn = true;
  let applying = false;
  // Our own setThinkingLevel calls also emit thinking_level_select, during or just after the call.
  let ownLevel: string | undefined;
  let firedWhileApplying = false;
  let lastReason = "";
  const pinned = thinkingPinned();

  const active = () => sessionOn && config.enabled && !pinned;

  const status = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, active() ? `effort: ${pi.getThinkingLevel()} (auto)` : undefined);
  };

  const manual = (level: string) => {
    state = { ...state, ceiling: level, dwell: config.policy.minDwell };
  };

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig("auto-effort", DEFAULT_CONFIG, ctx.cwd);
    const saved = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((e) => (e as Entry).type === "custom" && (e as Entry).customType === STATE_ENTRY) as Entry | undefined;
    const data = saved?.data as Partial<EffortState> | undefined;
    state =
      data && typeof data.ceiling === "string"
        ? { e: typeof data.e === "number" ? data.e : undefined, dwell: typeof data.dwell === "number" ? data.dwell : config.policy.minDwell, ceiling: data.ceiling }
        : { dwell: config.policy.minDwell, ceiling: pi.getThinkingLevel() };
    status(ctx);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const own = applying || (ownLevel !== undefined && event.level === ownLevel);
    ownLevel = undefined;
    if (applying) firedWhileApplying = true;
    if (own) return;
    manual(event.level);
    if (ctx) status(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    config = loadConfig("auto-effort", DEFAULT_CONFIG, ctx.cwd);
    if (!active() || !event.prompt.trim()) return;
    const current = pi.getThinkingLevel();
    const outcome = await askJev(ctx.modelRegistry, config.jev, effortState(event.prompt, ctx.sessionManager.getBranch()), QUESTIONS, ctx.signal);
    const depth = outcome.ok ? score(outcome.answers, "depth") : undefined;
    const ack = outcome.ok ? bool(outcome.answers, "ack") : undefined;
    const judgment = depth && ack !== undefined ? { score: depth.score, confidence: depth.confidence, ack } : undefined;
    const decision = decide(current, state, judgment, config.policy);
    state = decision.state;
    lastReason = outcome.ok ? decision.reason : `unavailable: ${outcome.reason}`;
    if (decision.level !== current) {
      applying = true;
      firedWhileApplying = false;
      try {
        pi.setThinkingLevel(decision.level as never);
      } finally {
        applying = false;
      }
      if (!firedWhileApplying) ownLevel = pi.getThinkingLevel();
    }
    pi.appendEntry(STATE_ENTRY, {
      ...state,
      from: current,
      level: pi.getThinkingLevel(),
      reason: lastReason,
      ...(judgment ? { score: judgment.score, confidence: judgment.confidence, ack: judgment.ack } : {}),
      ...(outcome.ok ? { latencyMs: outcome.latencyMs, inputTokens: outcome.usage?.input } : {}),
    });
    status(ctx);
  });

  pi.registerCommand("auto-effort", {
    description: "auto-effort: status, on, or off (this session)",
    getArgumentCompletions: (prefix: string) =>
      ["status", "on", "off"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),
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
      ctx.ui.notify(
        [
          `auto-effort ${active() ? "on" : pinned ? "off (--thinking was given)" : "off"}: ${pi.getThinkingLevel()} now, ceiling ${state.ceiling} (your last manual level), floor ${config.policy.floor}.`,
          `Running average ${state.e === undefined ? "-" : state.e.toFixed(2)}, ${state.dwell} message${state.dwell === 1 ? "" : "s"} at this level${lastReason ? `, last decision: ${lastReason}` : ""}.`,
        ].join("\n"),
        "info",
      );
    },
  });
}

function levelDiffers(a: string, b: string) {
  return a !== b;
}
