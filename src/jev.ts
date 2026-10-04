// Jev through Pi's own classifier models: `ctx.modelRegistry.findOfType("classifier", …)` and
// `ctx.modelRegistry.classify()`. Pi resolves the credentials (TYPESAFE_API_KEY for its `typesafe`
// provider, or any other classifier provider), applies the timeout and abort signal, and reports
// token usage. The types below mirror Pi's classifier API (Pi >= 0.99) structurally, so this
// package type-checks against older Pi type packages too.

export interface ClassifierBoolQuestion {
  type: "bool";
  instructions: string;
  criteria: { true: string; false: string };
}
export interface ClassifierChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface ClassifierScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}
export type ClassifierQuestion = ClassifierBoolQuestion | ClassifierChoiceQuestion | ClassifierScoreQuestion;

export type ClassifierAnswer =
  | { type: "bool"; probability: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number };

export interface ClassifierUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface ClassifierResult {
  model: string;
  answers: Record<string, ClassifierAnswer>;
  usage?: ClassifierUsage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
}

/** The part of Pi's model registry this package uses. */
export interface ClassifierRegistry {
  findOfType(type: "classifier", provider: string, modelId: string): unknown;
  classify(
    model: never,
    context: { state: Record<string, unknown>; questions: Record<string, ClassifierQuestion> },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ClassifierResult>;
}

export interface JevConfig {
  enabled: boolean;
  provider: string;
  model: string;
  timeoutMs: number;
}

export type JevOutcome =
  | { ok: true; answers: Record<string, ClassifierAnswer>; usage?: ClassifierUsage; model: string; latencyMs: number }
  | { ok: false; reason: string };

/** Ask Jev one request. Never throws: every failure is `{ ok: false, reason }`. */
export async function askJev(
  registry: unknown,
  config: JevConfig,
  state: Record<string, unknown>,
  questions: Record<string, ClassifierQuestion>,
  signal?: AbortSignal,
): Promise<JevOutcome> {
  if (!config.enabled) return { ok: false, reason: "Jev is off in settings" };
  const reg = registry as Partial<ClassifierRegistry> | undefined;
  if (typeof reg?.findOfType !== "function" || typeof reg.classify !== "function") {
    return { ok: false, reason: "this Pi has no classifier models (needs Pi 0.99 or newer)" };
  }
  let model: unknown;
  try {
    model = reg.findOfType("classifier", config.provider, config.model);
  } catch {
    model = undefined;
  }
  if (!model) return { ok: false, reason: `no classifier model ${config.provider}/${config.model}` };
  const started = Date.now();
  try {
    const result = await reg.classify(model as never, { state, questions }, {
      timeoutMs: config.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (result.stopReason !== "stop") {
      return { ok: false, reason: describe(result.stopReason, result.errorMessage) };
    }
    return {
      ok: true,
      answers: result.answers,
      ...(result.usage ? { usage: result.usage } : {}),
      model: result.model,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, reason: describe("error", error instanceof Error ? error.message : String(error)) };
  }
}

function describe(stopReason: string, message: string | undefined) {
  if (stopReason === "aborted") return "cancelled";
  const text = (message ?? "").replace(/\s+/gu, " ");
  if (/No API key/iu.test(text)) return "no classifier credentials";
  if (/\b401\b|unauthori[sz]ed/iu.test(text)) return "invalid API key";
  if (/timed out|timeout/iu.test(text)) return "timed out";
  return text.slice(0, 160) || "unknown error";
}

export function bool(answers: Record<string, ClassifierAnswer>, id: string): number | undefined {
  const answer = answers[id];
  return answer?.type === "bool" && Number.isFinite(answer.probability) ? answer.probability : undefined;
}

export function score(answers: Record<string, ClassifierAnswer>, id: string): { score: number; confidence: number } | undefined {
  const answer = answers[id];
  return answer?.type === "score" && Number.isFinite(answer.score) ? { score: answer.score, confidence: answer.confidence } : undefined;
}

export function choice(answers: Record<string, ClassifierAnswer>, id: string) {
  const answer = answers[id];
  return answer?.type === "choice" ? answer : undefined;
}
