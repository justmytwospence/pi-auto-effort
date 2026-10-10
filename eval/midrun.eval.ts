// Mid-run stretches rated by live Jev through Pi's model registry: `npm run eval`.
import { beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev, score } from "../src/jev.ts";
import { MID_RUN_QUESTIONS, runState } from "../src/midrun.ts";
import { hasCredentials, installedRegistry } from "./registry.ts";

type Step = { said?: string; calls: Array<[string, Record<string, unknown>]>; failed?: string[] };

const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
function entries(request: string, steps: Step[]) {
  return [
    user(request),
    ...steps.flatMap((s) => [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            ...(s.said ? [{ type: "text", text: s.said }] : []),
            ...s.calls.map(([name, args], i) => ({ type: "toolCall", id: String(i), name, arguments: args })),
          ],
        },
      },
      ...s.calls.map(([name], i) => {
        const error = s.failed?.[i];
        return { type: "message", message: { role: "toolResult", toolName: name, isError: Boolean(error), content: [{ type: "text", text: error ?? "ok" }] } };
      }),
    ]),
  ];
}

// Expected depth band [min, max] for the next step.
const CASES: Array<{ name: string; request: string; steps: Step[]; min: number; max: number }> = [
  {
    name: "mechanical edits after the plan is settled",
    request: "rename getUser to fetchUser everywhere",
    steps: [
      { said: "Found 14 call sites; updating them.", calls: [["edit", { path: "src/api.ts" }], ["edit", { path: "src/routes.ts" }]] },
      { calls: [["edit", { path: "src/hooks.ts" }], ["edit", { path: "src/pages/user.tsx" }]] },
      { calls: [["edit", { path: "src/pages/admin.tsx" }]] },
    ],
    min: 0,
    max: 1,
  },
  {
    name: "repeated failures with an unclear cause",
    request: "add retries to the HTTP client",
    steps: [
      { said: "Retries added; running tests.", calls: [["bash", { command: "npm test" }]], failed: ["FAIL client.test.ts: expected 3 calls, got 7"] },
      { said: "Backoff counter was off by one; fixed.", calls: [["edit", { path: "src/client.ts" }], ["bash", { command: "npm test" }]], failed: [undefined as never, "FAIL client.test.ts: timeout after 5000ms; FAIL pool.test.ts: socket hang up"] },
      { said: "Now a different failure in the connection pool, which I did not touch.", calls: [["bash", { command: "npm test -- pool" }]], failed: ["FAIL pool.test.ts: socket hang up (intermittent)"] },
    ],
    min: 2,
    max: 3,
  },
  {
    name: "reading around before a cross-cutting design",
    request: "make the sync engine merge offline edits without losing data",
    steps: [
      { said: "Reading the current sync code.", calls: [["read", { path: "src/sync/engine.ts" }], ["read", { path: "src/sync/queue.ts" }]] },
      { said: "Edits are last-write-wins keyed by timestamp; concurrent edits to the same field clobber each other. I need a merge strategy (CRDT or OT) that works with the queue.", calls: [["read", { path: "src/sync/conflict.ts" }]] },
    ],
    min: 2,
    max: 3,
  },
  {
    name: "wrapping up: final checks pass",
    request: "fix the typo in the CLI help text",
    steps: [
      { calls: [["edit", { path: "src/cli.ts" }]] },
      { said: "Fixed; checking.", calls: [["bash", { command: "npm test" }]] },
    ],
    min: 0,
    max: 1,
  },
];

describe.skipIf(!hasCredentials)("auto-effort mid-run live eval", () => {
  let registry: unknown;
  beforeAll(async () => {
    registry = await installedRegistry();
  });

  test.each(CASES)("$name", async (c) => {
    const outcome = await askJev(registry, { ...DEFAULT_CONFIG.jev, timeoutMs: 10_000 }, runState(entries(c.request, c.steps), 6), MID_RUN_QUESTIONS);
    if (!outcome.ok) throw new Error(outcome.reason);
    const depth = score(outcome.answers, "depth");
    console.log(`${c.name}: ${depth?.score.toFixed(2)} (confidence ${depth?.confidence.toFixed(2)})`);
    expect(depth?.score).toBeGreaterThanOrEqual(c.min - 0.5);
    expect(depth?.score).toBeLessThanOrEqual(c.max + 0.5);
  });
});
