// Requests rated by live Jev through Pi's model registry: `npm run eval`.
import { beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, QUESTIONS, effortState } from "../src/index.ts";
import { askJev, bool, score } from "../src/jev.ts";
import { hasCredentials, installedRegistry } from "./registry.ts";

// depth: 0 trivial, 1 routine, 2 multi-step, 3 hard. Within 0.9 of the label passes.
const CASES: Array<{ request: string; depth: number; ack?: boolean; previous?: string }> = [
  { request: "what does `git stash pop` do?", depth: 0 },
  { request: "rename the variable `tmp` to `buffer` in src/io.ts", depth: 0 },
  { request: "bump the version in package.json to 1.2.0", depth: 0 },
  { request: "what's in the README?", depth: 0 },
  { request: "add a --verbose flag to the CLI that prints each request URL", depth: 1 },
  { request: "fix the typo in the error message for missing config files", depth: 0 },
  { request: "write a unit test for parseDuration covering '1h30m'", depth: 1 },
  { request: "add retries with exponential backoff to the HTTP client and test them", depth: 2 },
  { request: "the CI build fails with 'Cannot find module ./config' only on Linux; find out why and fix it", depth: 2 },
  { request: "add pagination to the /users endpoint, following how /orders does it", depth: 2 },
  { request: "we have an intermittent deadlock in the job scheduler under load; find the root cause", depth: 3 },
  { request: "redesign the sync engine so offline edits merge without data loss; plan it first", depth: 3 },
  { request: "migrate the whole codebase from callbacks to async/await without changing behavior", depth: 3 },
  { request: "prove the rate limiter can never let more than N requests through in any window, and fix it if it can", depth: 3 },
  { request: "yes go ahead", depth: 2, ack: true, previous: "Plan: refactor the cache into an LRU with TTL across 6 files. Shall I proceed?" },
  { request: "continue", depth: 2, ack: true, previous: "I've done 3 of 5 steps of the migration. Continue?" },
  { request: "do it", depth: 1, ack: true, previous: "I can add the missing import. Want me to?" },
  { request: "thanks!", depth: 0 },
  { request: "now also handle the case where the token expires mid-request, that's the tricky part", depth: 3, previous: "Added token refresh on startup." },
  { request: "show me the diff", depth: 0 },
];

describe.skipIf(!hasCredentials)("auto-effort live eval", () => {
  let registry: unknown;
  beforeAll(async () => {
    registry = await installedRegistry();
  });

  test.each(CASES)("$depth: $request", async (c) => {
    const entries = c.previous
      ? [{ type: "message", message: { role: "user", content: "earlier request" } }, { type: "message", message: { role: "assistant", content: [{ type: "text", text: c.previous }] } }]
      : [];
    const outcome = await askJev(registry, { ...DEFAULT_CONFIG.jev, timeoutMs: 15_000 }, effortState(c.request, entries), QUESTIONS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const depth = score(outcome.answers, "depth");
    const ack = bool(outcome.answers, "ack") ?? 0;
    console.log(`${c.depth}  got ${depth?.score.toFixed(2)} (conf ${depth?.confidence.toFixed(2)}) ack ${ack.toFixed(2)}  ${c.request.slice(0, 70)}  ${outcome.latencyMs} ms`);
    if (c.ack !== undefined) expect(ack > 0.7).toBe(c.ack);
    if (!c.ack) expect(Math.abs((depth?.score ?? -9) - c.depth)).toBeLessThanOrEqual(0.9);
  });
});
