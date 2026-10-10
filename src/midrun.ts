// Mid-run re-assessment: between tool turns of one run, Jev rates the work the agent is doing now
// (not the request that started the run), so a long run can move up for a hard stretch and back
// down for mechanical work. Only on models that take an effort change mid-conversation without
// losing the prompt cache.
import type { ClassifierQuestion } from "./jev.ts";
import { clip, messageText } from "./transcript.ts";

export interface MidRunConfig {
  enabled: boolean;
  /** Tool turns between assessments. */
  everyTurns: number;
  /** A turn with this many failed tool calls is assessed at once (0 = never early). */
  errorTurns: number;
  /** Assistant steps Jev sees. */
  steps: number;
  /**
   * `provider/id` globs (`*` matches anything) of models allowed beyond those Pi marks as taking a
   * mid-conversation effort change (`compat.supportsMidConvoEffort`).
   */
  models: string[];
}

export const DEFAULT_MID_RUN: MidRunConfig = { enabled: true, everyTurns: 3, errorTurns: 1, steps: 6, models: [] };

export const MID_RUN_QUESTIONS: Record<string, ClassifierQuestion> = {
  depth: {
    type: "score",
    instructions:
      "A coding agent is part-way through `request`. Given its `recent_steps` (oldest first) and `signals`, how much careful reasoning does its next step need?",
    criteria: [
      "Mechanical: reading files, running commands, applying a known fix, or reporting back",
      "Routine: a clear single-file change or a straightforward check",
      "Multi-step work, debugging with clear symptoms, or design inside a known pattern",
      "Subtle design, a cross-cutting change, hard debugging (repeated failures, unclear cause), or correctness-critical work",
    ],
  },
};

interface ModelLike {
  provider?: string;
  id?: string;
  compat?: unknown;
}

/** True when the model takes a mid-conversation effort change without losing its cache. */
export function midRunSupported(model: ModelLike | undefined, extra: readonly string[] = []): boolean {
  if (!model) return false;
  const compat = model.compat as { supportsMidConvoEffort?: unknown } | undefined;
  if (compat?.supportsMidConvoEffort === true) return true;
  const key = `${model.provider ?? ""}/${model.id ?? ""}`;
  return extra.some((glob) => globMatch(glob, key));
}

export function globMatch(glob: string, text: string): boolean {
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`, "u").test(text);
}

/** Whether to assess after this turn. */
export function shouldAssess(config: MidRunConfig, turnsSince: number, turnErrors: number): boolean {
  if (turnsSince < 1) return false;
  if (config.errorTurns > 0 && turnErrors >= config.errorTurns) return true;
  return turnsSince >= Math.max(1, config.everyTurns);
}

interface Entry {
  type?: string;
  message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean };
}

interface ToolCallBlock {
  type?: string;
  name?: string;
  arguments?: unknown;
}

/** The Jev state mid-run: the request that started the run and what the agent has done since. */
export function runState(entries: readonly unknown[], steps: number): Record<string, unknown> {
  const list = entries as Entry[];
  let start = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.type === "message" && list[i]?.message?.role === "user") {
      start = i;
      break;
    }
  }
  const request = start >= 0 ? messageText(list[start]?.message?.content).trim() : "";
  const all: Array<{ said?: string; calls: string[]; failed: string[] }> = [];
  const signals = { turns: 0, tool_calls: 0, errors: 0, files_edited: 0 };
  for (const entry of list.slice(start + 1)) {
    const m = entry.message;
    if (entry.type !== "message" || !m) continue;
    if (m.role === "assistant") {
      const calls = Array.isArray(m.content) ? (m.content as ToolCallBlock[]).filter((b) => b?.type === "toolCall") : [];
      const said = messageText(m.content).trim();
      all.push({ ...(said ? { said: clip(said, 400) } : {}), calls: calls.map(describeCall), failed: [] });
      signals.turns++;
      signals.tool_calls += calls.length;
    } else if (m.role === "toolResult") {
      if (m.isError) {
        signals.errors++;
        all.at(-1)?.failed.push(clip(`${m.toolName ?? "tool"}: ${messageText(m.content).trim()}`, 300));
      } else if (m.toolName === "edit" || m.toolName === "write") signals.files_edited++;
    }
  }
  const recent = all.slice(-Math.max(1, steps)).map((s) => ({
    ...(s.said ? { said: s.said } : {}),
    ...(s.calls.length ? { calls: s.calls } : {}),
    ...(s.failed.length ? { failed: s.failed } : {}),
  }));
  return { request: clip(request || "(unknown)", 4_000), recent_steps: recent.length ? recent : ["(none yet)"], signals };
}

function describeCall(call: ToolCallBlock): string {
  const args = call.arguments;
  let detail = "";
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const main = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.task;
    detail = typeof main === "string" ? main : JSON.stringify(args);
  }
  return clip(`${call.name ?? "tool"}${detail ? ` ${detail}` : ""}`, 200);
}
