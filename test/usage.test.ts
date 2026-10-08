import { expect, test } from "vitest";
import autoEffort from "../src/index.ts";
import { CodexPoller, codexAccountId, retryAfterMs } from "../src/usage.ts";
import { fakeJev, harness } from "./harness.ts";

const M = 60_000;
const t0 = Date.UTC(2026, 0, 1);
const answers = (depth: number) => ({ depth: { type: "score", score: depth, confidence: 0.9 }, ack: { type: "bool", probability: 0.02 } });

function jwt(account: string) {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_account_id: account } })}.sig`;
}

const usageBody = (primary: number, secondary = 10) =>
  JSON.stringify({
    rate_limit: {
      primary_window: { used_percent: primary, reset_at: (t0 + 120 * M) / 1000, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: secondary, reset_at: (t0 + 5 * 24 * 60 * M) / 1000, limit_window_seconds: 604_800 },
    },
  });

const anthropicHeaders = (used: number, resetMin: number) => ({
  "anthropic-ratelimit-unified-5h-utilization": String(used),
  "anthropic-ratelimit-unified-5h-reset": String((t0 + resetMin * M) / 1000),
  "anthropic-ratelimit-unified-5h-status": "allowed",
});

function setup(provider: string, options: { fetch?: typeof fetch; token?: () => string | undefined } = {}) {
  let clock = t0;
  const h = harness();
  autoEffort(h.pi, { now: () => clock, ...(options.fetch ? { fetch: options.fetch } : {}), codexTimeoutMs: 20 });
  const jev = fakeJev(() => answers(3));
  const registry = Object.assign(jev.registry as object, { getApiKeyForProvider: async () => options.token?.() ?? jwt("acct-1") });
  const ctx = h.ctx({ modelRegistry: registry, model: { provider, id: "m" }, sessionManager: { getBranch: () => [] } });
  return { h, ctx, advance: (ms: number) => (clock += ms), now: () => clock };
}

test("Anthropic headers on a risky pace lower the level after a confirming prompt, and the level comes back when the window resets", async () => {
  const { h, ctx, advance, now } = setup("anthropic");
  await h.emit("session_start", { type: "session_start" }, ctx);
  // 34% used with 80% of the 5h window left: projected 170% at reset.
  await h.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: anthropicHeaders(0.34, 240) }, ctx);
  await h.emit("before_agent_start", { prompt: "redesign the sync engine" }, ctx);
  expect(h.thinking).toBe("high");

  advance(5 * M);
  await h.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: anthropicHeaders(0.35, 240) }, ctx);
  await h.emit("before_agent_start", { prompt: "and the tests" }, ctx);
  expect(h.thinking).toBe("low");
  expect(h.entries.at(-1)?.data).toMatchObject({ baseline: "high", level: "low", limit: { tier: "critical", steps: 2, window: "5h" } });
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: low (auto, limited: 5h 35%)");
  expect(ctx.ui.notes.at(-1)?.message).toMatch(/^auto-effort: 5h window 35% used, projected \d+% at reset .*; effort lowered 2 levels$/);

  // A limited stretch does not drag the policy's own level down.
  advance(M);
  await h.emit("before_agent_start", { prompt: "more" }, ctx);
  expect(h.entries.at(-1)?.data).toMatchObject({ baseline: "high", level: "low" });

  // The window rolls over: the cut lifts at the next prompt.
  advance(M);
  await h.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: anthropicHeaders(0.01, 540) }, ctx);
  await h.emit("before_agent_start", { prompt: "next" }, ctx);
  expect(h.thinking).toBe("high");
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: high (auto)");
  expect(ctx.ui.notes.at(-1)?.message).toBe("auto-effort: usage limit lifted; effort back to normal");
  expect(now()).toBe(t0 + 7 * M);

  await h.commands.get("auto-effort").handler("limits", ctx);
  expect(ctx.ui.notes.at(-1)?.message).toMatch(/^limits: 5h: 1% used, .*tier none/);
});

test("limits.enabled false, or no readings (an API key), leave the level to the policy", async () => {
  const { h, ctx } = setup("anthropic");
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: { "anthropic-ratelimit-tokens-remaining": "10" } }, ctx);
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  expect(h.thinking).toBe("high");
  await h.commands.get("auto-effort").handler("status", ctx);
  expect(ctx.ui.notes.at(-1)?.message).toContain("limits: no readings for anthropic yet");
});

test("Codex usage is polled with Pi's token and account, and caps the level", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return new Response(usageBody(80));
  }) as unknown as typeof fetch;
  const { h, ctx } = setup("openai-codex", { fetch: fetchImpl });
  await h.emit("session_start", { type: "session_start" }, ctx);
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: "https://chatgpt.com/backend-api/wham/usage",
    headers: { Authorization: `Bearer ${jwt("acct-1")}`, "chatgpt-account-id": "acct-1", originator: "pi", accept: "application/json" },
  });
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  expect(h.thinking).toBe("medium");
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto, limited: 5h 80%)");
  // Within 5 minutes no new request.
  await h.emit("agent_settled", { type: "agent_settled" }, ctx);
  expect(calls).toHaveLength(1);
});

test("a prompt never waits on a hanging usage request", async () => {
  const fetchImpl = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
  const { h, ctx } = setup("openai-codex", { fetch: fetchImpl });
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  expect(h.thinking).toBe("high");
});

function poller(responses: Array<() => Response | Promise<Response>>, token: () => string = () => jwt("a")) {
  let clock = t0;
  const recorded: unknown[][] = [];
  let calls = 0;
  const p = new CodexPoller({
    fetch: (async (_url: string, init: RequestInit) => {
      calls++;
      const next = responses.shift();
      if (!next) throw new Error("no response");
      return await new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        Promise.resolve(next()).then(resolve, reject);
      });
    }) as unknown as typeof fetch,
    now: () => clock,
    timeoutMs: 20,
    token: async () => token(),
    onAccount: () => undefined,
    record: (r) => recorded.push(r),
  });
  return { p, recorded, calls: () => calls, advance: (ms: number) => (clock += ms) };
}

test("poller: a timeout keeps the last reading and backs off", async () => {
  const s = poller([() => new Response(usageBody(50)), () => new Promise<Response>(() => undefined), () => new Response(usageBody(60))]);
  await s.p.refresh();
  expect(s.recorded).toHaveLength(1);
  s.advance(6 * M);
  await s.p.refresh();
  expect(s.recorded).toHaveLength(1);
  expect(s.calls()).toBe(2);
  // Failed: back off 5 minutes past the failure, so not at +4, yes at +6.
  s.advance(4 * M);
  await s.p.refresh();
  expect(s.calls()).toBe(2);
  s.advance(2 * M);
  await s.p.refresh();
  expect(s.calls()).toBe(3);
  expect(s.recorded).toHaveLength(2);
});

test("poller: 429 honours Retry-After, else backs off from 15 minutes", async () => {
  const limited = (after?: string) => () => new Response("", { status: 429, headers: after ? { "retry-after": after } : {} });
  const s = poller([limited("3600"), limited(), limited(), () => new Response(usageBody(5))]);
  await s.p.refresh();
  s.advance(59 * M);
  await s.p.refresh();
  expect(s.calls()).toBe(1);
  s.advance(2 * M);
  await s.p.refresh();
  expect(s.calls()).toBe(2);
  // No Retry-After: 15 minutes, then 30.
  s.advance(14 * M);
  await s.p.refresh();
  expect(s.calls()).toBe(2);
  s.advance(2 * M);
  await s.p.refresh();
  expect(s.calls()).toBe(3);
  s.advance(29 * M);
  await s.p.refresh();
  expect(s.calls()).toBe(3);
  s.advance(2 * M);
  await s.p.refresh();
  expect(s.calls()).toBe(4);
  expect(s.recorded).toHaveLength(1);
});

test("poller: 401 stops polling until the token changes", async () => {
  let token = jwt("a");
  const s = poller([() => new Response("", { status: 401 }), () => new Response(usageBody(5))], () => token);
  await s.p.refresh();
  s.advance(6 * M);
  await s.p.refresh();
  expect(s.calls()).toBe(1);
  token = jwt("a").replace("sig", "sig2");
  s.advance(6 * M);
  await s.p.refresh();
  expect(s.calls()).toBe(2);
  expect(s.recorded).toHaveLength(1);
});

test("poller: a late response from the previous account is dropped", async () => {
  let token = jwt("a");
  const s = poller(
    [
      () => {
        token = jwt("b");
        return new Response(usageBody(90));
      },
    ],
    () => token,
  );
  await s.p.refresh();
  expect(s.calls()).toBe(1);
  expect(s.recorded).toEqual([]);
});

test("account id and Retry-After parsing", () => {
  expect(codexAccountId(jwt("acct-9"))).toBe("acct-9");
  expect(codexAccountId("sk-not-a-jwt")).toBeUndefined();
  expect(retryAfterMs("120", t0)).toBe(120_000);
  expect(retryAfterMs(new Date(t0 + 60_000).toUTCString(), t0)).toBe(60_000);
  expect(retryAfterMs(null, t0)).toBeUndefined();
  expect(retryAfterMs("soon", t0)).toBeUndefined();
});
