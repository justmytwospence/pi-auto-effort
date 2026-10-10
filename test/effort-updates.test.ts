import { expect, test } from "vitest";
import autoEffort, { effortUpdatesConfig } from "../src/index.ts";
import { DEFAULT_EFFORT_UPDATES, emptyState, plan, restoreState, rewritePayload } from "../src/effort-updates.ts";
import { fakeJev, harness, userEntry } from "./harness.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const asst = (text: string, id?: string) => ({ type: "message", role: "assistant", ...(id ? { id, status: "completed" } : {}), content: [{ type: "output_text", text }] });
const call = (id: string) => ({ type: "function_call", call_id: id, name: "bash", arguments: "{}" });
const out = (id: string) => ({ type: "function_call_output", call_id: id, output: "ok" });
const cfg = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });

test("the first request sets the baseline; later changes become items replayed in place", () => {
  const s = emptyState();
  const h1 = [user("plan it")];
  expect(plan(s, h1, "low")).toMatchObject({ input: h1, effort: "low", changed: true });

  // Mid-run: the level goes up after a tool result.
  const h2 = [...h1, asst("ok"), call("1"), out("1")];
  const p2 = plan(s, h2, "high");
  expect(p2.effort).toBe("low");
  expect(p2.input).toEqual([...h2, cfg("high")]);

  // The next request replays it in place, unchanged effort: nothing new.
  const h3 = [...h2, call("2"), out("2")];
  const p3 = plan(s, h3, "high");
  expect(p3).toMatchObject({ effort: "low", changed: false });
  expect(p3.input).toEqual([...h2, cfg("high"), call("2"), out("2")]);

  // A new prompt at a lower level: the item goes before the user message.
  const h4 = [...h3, asst("done"), user("thanks")];
  const p4 = plan(s, h4, "medium");
  expect(p4.input).toEqual([...h2, cfg("high"), call("2"), out("2"), asst("done"), cfg("medium"), user("thanks")]);
  expect(p4.effort).toBe("low");
});

test("two changes at one position merge; a change back to the level in force adds nothing", () => {
  const s = emptyState();
  const h = [user("a"), asst("b"), call("1"), out("1")];
  plan(s, h.slice(0, 1), "medium");
  plan(s, h, "high");
  const merged = plan(s, h, "xhigh");
  expect(merged.input.filter((i: any) => i.type === "configuration_update")).toEqual([cfg("xhigh")]);
  const back = plan(s, h, "medium");
  expect(back.input).toEqual(h);
});

test("a rewritten history resets the baseline; output-only fields do not count as a rewrite", () => {
  const s = emptyState();
  plan(s, [user("a")], "low");
  const live = [user("a"), asst("b", "msg_1"), call("1"), out("1")];
  plan(s, live, "high");
  // A replay drops id/status: still the same history.
  const replay = [user("a"), asst("b"), call("1"), out("1"), call("2"), out("2")];
  expect(plan(s, replay, "high")).toMatchObject({ effort: "low", changed: false });
  // Compaction rewrote it: start over at the requested effort.
  const compacted = [user("summary of everything"), user("next")];
  expect(plan(s, compacted, "high")).toMatchObject({ input: compacted, effort: "high", changed: true });
  expect(s.transitions).toEqual([]);
});

test("rewritePayload pins the effort, and leaves other payloads alone", () => {
  const s = emptyState();
  const first = { model: "gpt-6-astra", input: [user("a")], reasoning: { effort: "medium", summary: "auto" } };
  rewritePayload(s, first);
  const second = { model: "gpt-6-astra", input: [user("a"), asst("b"), call("1"), out("1")], reasoning: { effort: "xhigh", summary: "auto" } };
  expect(rewritePayload(s, second)).toBe(true);
  expect(second.reasoning).toEqual({ effort: "medium", summary: "auto" });
  expect(second.input.at(-1)).toEqual(cfg("xhigh"));

  for (const other of [{ messages: [] }, { input: [user("a")] }, { input: [user("a")], reasoning: { effort: "none" } }, { input: [cfg("low"), user("a")], reasoning: { effort: "low" } }]) {
    const before = JSON.stringify(other);
    expect(rewritePayload(s, other)).toBe(false);
    expect(JSON.stringify(other)).toBe(before);
  }
});

test("restoreState keeps valid fields only", () => {
  expect(restoreState(undefined)).toEqual({ transitions: [] });
  expect(restoreState({ base: "low", current: "high", transitions: [{ index: 3, anchor: "x", effort: "high" }, { index: 1.5, anchor: "y", effort: "high" }, { index: 2, anchor: "z", effort: "ultra" }] })).toEqual({
    base: "low",
    current: "high",
    transitions: [{ index: 3, anchor: "x", effort: "high" }],
  });
  expect(effortUpdatesConfig({ models: ["a/*", 1] })).toEqual({ ...DEFAULT_EFFORT_UPDATES, models: ["a/*"] });
});

const astra = { provider: "openai-codex", id: "gpt-6-astra", compat: {} };

function setup(model: unknown, branch: unknown[] = [userEntry("x")]) {
  const h = harness();
  autoEffort(h.pi);
  const jev = fakeJev(() => ({ depth: { type: "score", score: 3, confidence: 0.9 }, ack: { type: "bool", probability: 0 } }));
  const ctx = h.ctx({ modelRegistry: jev.registry, model, sessionManager: { getBranch: () => branch } });
  return { h, jev, ctx };
}

test("the hook rewrites requests for listed models, persists the state, and restores it", async () => {
  const { h, ctx } = setup(astra);
  await h.emit("session_start", { type: "session_start" }, ctx);
  const p1 = { model: "gpt-6-astra", input: [user("a")], reasoning: { effort: "low" } };
  expect(await h.emit("before_provider_request", { type: "before_provider_request", payload: p1 }, ctx)).toBe(p1);
  const p2 = { model: "gpt-6-astra", input: [user("a"), asst("b"), call("1"), out("1")], reasoning: { effort: "high" } };
  await h.emit("before_provider_request", { type: "before_provider_request", payload: p2 }, ctx);
  expect(p2.reasoning.effort).toBe("low");
  const saved = h.entries.filter((e) => e.customType === "auto-effort:effort-updates");
  expect(saved).toHaveLength(2);
  expect(saved.at(-1)?.data).toMatchObject({ base: "low", current: "high", transitions: [{ index: 4, effort: "high" }] });

  // A resumed session picks up where it left off.
  const r = setup(astra, [{ type: "custom", customType: "auto-effort:effort-updates", data: saved.at(-1)?.data }]);
  await r.h.emit("session_start", { type: "session_start" }, r.ctx);
  const p3 = { model: "gpt-6-astra", input: [...p2.input.slice(0, 4), call("2"), out("2")], reasoning: { effort: "high" } };
  await r.h.emit("before_provider_request", { type: "before_provider_request", payload: p3 }, r.ctx);
  expect(p3.reasoning.effort).toBe("low");
  expect(p3.input[4]).toEqual(cfg("high"));
});

test("the hook leaves unlisted models and mismatched payloads alone", async () => {
  for (const model of [{ provider: "openai-codex", id: "gpt-6-luna" }, { provider: "openai", id: "gpt-6-astra" }]) {
    const { h, ctx } = setup(model);
    await h.emit("session_start", { type: "session_start" }, ctx);
    const p = { model: model.id, input: [user("a")], reasoning: { effort: "low" } };
    expect(await h.emit("before_provider_request", { type: "before_provider_request", payload: p }, ctx)).toBeUndefined();
    expect(h.entries).toHaveLength(0);
  }
  const { h, ctx } = setup(astra);
  await h.emit("session_start", { type: "session_start" }, ctx);
  expect(await h.emit("before_provider_request", { type: "before_provider_request", payload: { model: "other", input: [], reasoning: { effort: "low" } } }, ctx)).toBeUndefined();
});

test("listed models get mid-run re-assessment", async () => {
  const { h, jev, ctx } = setup(astra);
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  await h.emit("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ isError: true }] }, ctx);
  expect(jev.calls).toHaveLength(2);
});
