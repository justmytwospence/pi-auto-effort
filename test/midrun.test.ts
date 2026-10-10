import { expect, test } from "vitest";
import autoEffort, { midRunConfig } from "../src/index.ts";
import { DEFAULT_MID_RUN, globMatch, midRunSupported, runState, shouldAssess } from "../src/midrun.ts";
import { fakeJev, harness, userEntry } from "./harness.ts";

const answers = (depth: number, ack = 0.05) => ({ depth: { type: "score", score: depth, confidence: 0.9 }, ack: { type: "bool", probability: ack } });
const managed = { provider: "anthropic", id: "claude-opus-5", compat: { supportsMidConvoEffort: true } };
const older = { provider: "anthropic", id: "claude-opus-4-7", compat: {} };

function call(name: string, args: Record<string, unknown>) {
  return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name, arguments: args }] } };
}
function result(toolName: string, isError = false, text = "") {
  return { type: "message", message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }] } };
}
const turn = (errors = 0) => ({
  type: "turn_end",
  turnIndex: 0,
  message: { role: "assistant", stopReason: "toolUse" },
  toolResults: [{ isError: errors > 0 }, ...Array.from({ length: Math.max(0, errors - 1) }, () => ({ isError: true }))],
});

function setup(script: number[], model: unknown = managed) {
  const h = harness();
  autoEffort(h.pi);
  const queue = [...script];
  const jev = fakeJev(() => answers(queue.shift() ?? 1));
  const branch: unknown[] = [userEntry("refactor the sync engine"), call("read", { path: "src/sync.ts" }), result("read")];
  const ctx = h.ctx({ modelRegistry: jev.registry, model, sessionManager: { getBranch: () => branch } });
  return { h, jev, ctx, branch };
}

test("re-assesses every few tool turns on a managed-effort model, capped at the ceiling", async () => {
  const { h, jev, ctx } = setup([1, 3, 0, 0, 0]);
  h.pi.setThinkingLevel("xhigh");
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "refactor the sync engine" }, ctx);
  expect(h.thinking).toBe("medium");
  await h.emit("turn_end", turn(), ctx);
  await h.emit("turn_end", turn(), ctx);
  expect(jev.calls).toHaveLength(1);
  await h.emit("turn_end", turn(), ctx);
  expect(jev.calls).toHaveLength(2);
  expect(jev.calls[1]?.questions).toHaveProperty("depth");
  expect(jev.calls[1]?.questions).not.toHaveProperty("ack");
  expect(h.thinking).toBe("xhigh");
  expect(h.entries.at(-1)?.data).toMatchObject({ phase: "run", reason: "jump", level: "xhigh" });
  // Going down waits for the dwell: the level holds for two assessments first.
  for (let i = 0; i < 6; i++) await h.emit("turn_end", turn(), ctx);
  expect(h.thinking).toBe("xhigh");
  for (let i = 0; i < 3; i++) await h.emit("turn_end", turn(), ctx);
  expect(h.thinking).toBe("low");
  expect(h.entries.at(-1)?.data).toMatchObject({ phase: "run", reason: "down" });
});

test("a turn with a failed tool call is assessed at once", async () => {
  const { h, jev, ctx } = setup([1, 3]);
  h.pi.setThinkingLevel("xhigh");
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  await h.emit("turn_end", turn(1), ctx);
  expect(jev.calls).toHaveLength(2);
  expect(h.thinking).toBe("xhigh");
});

test("no mid-run change on other models, on the final turn, or when off", async () => {
  const s = setup([1, 3, 3, 3], older);
  await s.h.emit("session_start", { type: "session_start" }, s.ctx);
  await s.h.emit("before_agent_start", { prompt: "x" }, s.ctx);
  for (let i = 0; i < 4; i++) await s.h.emit("turn_end", turn(1), s.ctx);
  expect(s.jev.calls).toHaveLength(1);

  const t = setup([1, 3]);
  await t.h.emit("session_start", { type: "session_start" }, t.ctx);
  await t.h.emit("before_agent_start", { prompt: "x" }, t.ctx);
  for (let i = 0; i < 4; i++) await t.h.emit("turn_end", { ...turn(), toolResults: [] }, t.ctx);
  await t.h.emit("turn_end", { ...turn(1), message: { role: "assistant", stopReason: "aborted" } }, t.ctx);
  expect(t.jev.calls).toHaveLength(1);

  const u = setup([1, 3]);
  await u.h.emit("session_start", { type: "session_start" }, u.ctx);
  await u.h.commands.get("auto-effort").handler("off", u.ctx);
  await u.h.emit("turn_end", turn(1), u.ctx);
  expect(u.jev.calls).toHaveLength(0);
});

test("a new prompt resets the turn count", async () => {
  const { h, jev, ctx } = setup([1, 1, 1, 1]);
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "a" }, ctx);
  await h.emit("turn_end", turn(), ctx);
  await h.emit("turn_end", turn(), ctx);
  await h.emit("before_agent_start", { prompt: "b" }, ctx);
  await h.emit("turn_end", turn(), ctx);
  expect(jev.calls).toHaveLength(2);
});

test("midRunSupported: compat flag or an allowlisted glob", () => {
  expect(midRunSupported(managed)).toBe(true);
  expect(midRunSupported(older)).toBe(false);
  expect(midRunSupported(older, ["anthropic/claude-opus-4-*"])).toBe(true);
  expect(midRunSupported(undefined, ["*"])).toBe(false);
  expect(globMatch("openai-codex/*", "openai-codex/gpt-5.5")).toBe(true);
  expect(globMatch("openai/gpt-5.?", "openai/gpt-5.5")).toBe(false);
});

test("shouldAssess and midRunConfig", () => {
  expect(shouldAssess(DEFAULT_MID_RUN, 2, 0)).toBe(false);
  expect(shouldAssess(DEFAULT_MID_RUN, 3, 0)).toBe(true);
  expect(shouldAssess(DEFAULT_MID_RUN, 1, 1)).toBe(true);
  expect(shouldAssess({ ...DEFAULT_MID_RUN, errorTurns: 0 }, 1, 5)).toBe(false);
  expect(midRunConfig({ everyTurns: 0, errorTurns: -1, steps: "x", models: ["a/*", 3] })).toEqual({ ...DEFAULT_MID_RUN, everyTurns: 1, models: ["a/*"] });
});

test("runState describes the current run", () => {
  const entries = [
    userEntry("old request"),
    userEntry("fix the flaky test"),
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Running it." }, { type: "toolCall", id: "1", name: "bash", arguments: { command: "npm test" } }] } },
    result("bash", true, "1 failed"),
    call("edit", { path: "src/a.ts", edits: [] }),
    result("edit"),
  ];
  expect(runState(entries, 6)).toEqual({
    request: "fix the flaky test",
    recent_steps: [{ said: "Running it.", calls: ["bash npm test"], failed: ["bash: 1 failed"] }, { calls: ["edit src/a.ts"] }],
    signals: { turns: 2, tool_calls: 2, errors: 1, files_edited: 1 },
  });
  expect(runState(entries, 1).recent_steps).toHaveLength(1);
});
