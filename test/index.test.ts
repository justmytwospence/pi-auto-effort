import { expect, test } from "vitest";
import autoEffort, { effortState, thinkingPinned } from "../src/index.ts";
import { assistantEntry, fakeJev, harness, userEntry } from "./harness.ts";

const answers = (depth: number, ack = 0.05) => ({ depth: { type: "score", score: depth, confidence: 0.9 }, ack: { type: "bool", probability: ack } });

function setup(script: number[]) {
  const h = harness();
  autoEffort(h.pi);
  const queue = [...script];
  const jev = fakeJev(() => answers(queue.shift() ?? 1));
  const ctx = h.ctx({ modelRegistry: jev.registry, sessionManager: { getBranch: () => [] } });
  return { h, jev, ctx };
}

test("effort follows the requests, capped at the manual level", async () => {
  const { h, ctx } = setup([0, 3, 3]);
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "what does ls -a do?" }, ctx);
  expect(h.thinking).toBe("low");
  await h.emit("before_agent_start", { prompt: "redesign the sync engine" }, ctx);
  expect(h.thinking).toBe("high");
  expect(h.entries.at(-1)).toMatchObject({ customType: "auto-effort:state", data: { reason: "jump", ceiling: "high" } });
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: high (auto)");
});

test("a manual change becomes the new ceiling; own changes do not", async () => {
  const { h, ctx } = setup([3, 3]);
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("thinking_level_select", { type: "thinking_level_select", level: "medium", previousLevel: "high" }, ctx);
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  // Above the new ceiling, the level comes down to it even for a hard request.
  expect(h.thinking).toBe("medium");
  expect(h.entries.at(-1)?.data).toMatchObject({ ceiling: "medium" });
});

test("Jev unavailable keeps the level; /auto-effort off restores the ceiling", async () => {
  const h = harness();
  autoEffort(h.pi);
  const jev = fakeJev(() => ({ stopReason: "error", errorMessage: "timeout", answers: {} }));
  const ctx = h.ctx({ modelRegistry: jev.registry, sessionManager: { getBranch: () => [] } });
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  expect(h.thinkingChanges).toEqual([]);
  expect(h.entries.at(-1)?.data).toMatchObject({ reason: "unavailable: timed out" });

  const s = setup([0]);
  await s.h.emit("session_start", { type: "session_start" }, s.ctx);
  await s.h.emit("before_agent_start", { prompt: "trivial" }, s.ctx);
  expect(s.h.thinking).toBe("low");
  await s.h.commands.get("auto-effort").handler("off", s.ctx);
  expect(s.h.thinking).toBe("high");
});

test("state is restored from the branch", async () => {
  const h = harness();
  autoEffort(h.pi);
  const jev = fakeJev(() => answers(3));
  const ctx = h.ctx({
    modelRegistry: jev.registry,
    sessionManager: { getBranch: () => [{ type: "custom", customType: "auto-effort:state", data: { e: 0.2, dwell: 0, ceiling: "xhigh" } }] },
  });
  h.pi.setThinkingLevel("low");
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  expect(h.thinking).toBe("xhigh");
});

test("effortState describes the request and the previous run", () => {
  const entries = [
    userEntry("Add caching"),
    assistantEntry("Plan: add an LRU."),
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "edit" }] } },
    { type: "message", message: { role: "toolResult", toolName: "edit", isError: false, content: [] } },
    { type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: [] } },
    assistantEntry("Done; one test fails."),
    userEntry("fix it"),
  ];
  expect(effortState("fix it", entries)).toEqual({
    request: "fix it",
    previous_requests: ["Add caching"],
    last_outcome: "Done; one test fails.",
    signals: { last_run_errors: 1, files_edited: 1, tool_calls: 1 },
  });
});

test("thinkingPinned", () => {
  expect(thinkingPinned(["node", "pi", "--thinking", "high"])).toBe(true);
  expect(thinkingPinned(["node", "pi", "--model", "x"])).toBe(false);
});
