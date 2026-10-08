// Codex usage for the limits stage. Pi's default Codex transport (WebSocket) carries no
// `x-codex-*` headers, so the windows are read from ChatGPT's own usage endpoint with the token
// and account Pi itself sends (the same request pi-status-footer makes). Readings stay in memory.
import { type Reading, readCodexUsage } from "./limits.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_JWT_CLAIM = "https://api.openai.com/auth";

const MINUTE = 60_000;
/** A reading younger than this is not refreshed. */
export const REFRESH_MS = 5 * MINUTE;
const RATE_LIMITED_MS = 15 * MINUTE;
const FAILED_MS = 5 * MINUTE;
const MAX_BACKOFF_MS = 60 * MINUTE;

/** The ChatGPT account id in a Codex OAuth token; undefined for anything that is not one. */
export function codexAccountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload[CODEX_JWT_CLAIM] as Record<string, unknown> | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** `Retry-After` in ms: seconds or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export interface PollerDeps {
  fetch: typeof fetch;
  now: () => number;
  timeoutMs: number;
  /** Pi's token for openai-codex (refreshed by Pi); undefined when there is none. */
  token: () => Promise<string | undefined>;
  /** The account changed: readings of the old one must go. */
  onAccount: (account: string) => void;
  record: (readings: Reading[]) => void;
}

/** One request at a time, at most every 5 minutes, backing off on 429 and failures, stopping on 401/403 until the token changes. */
export class CodexPoller {
  private inFlight: Promise<void> | undefined;
  private lastAttempt = -Infinity;
  private notBefore = -Infinity;
  private backoff = { limited: 0, failed: 0 };
  private rejectedToken: string | undefined;
  private account: string | undefined;

  constructor(private deps: PollerDeps) {}

  /** Starts a refresh when one is due; resolves when it finishes (never rejects). */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const now = this.deps.now();
    if (now - this.lastAttempt < REFRESH_MS || now < this.notBefore) return Promise.resolve();
    this.lastAttempt = now;
    this.inFlight = this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    let token: string | undefined;
    try {
      token = await this.deps.token();
    } catch {
      return;
    }
    if (!token || token === this.rejectedToken) return;
    const account = codexAccountId(token);
    if (!account) return;
    if (account !== this.account) {
      this.account = account;
      this.deps.onAccount(account);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    try {
      const response = await this.deps.fetch(CODEX_USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": account, originator: "pi", accept: "application/json" },
        signal: controller.signal,
      });
      const now = this.deps.now();
      if (response.status === 401 || response.status === 403) {
        this.rejectedToken = token;
        return;
      }
      if (response.status === 429) {
        const after = retryAfterMs(response.headers.get("retry-after"), now);
        if (after === undefined) this.backoff.limited = Math.min(MAX_BACKOFF_MS, this.backoff.limited ? this.backoff.limited * 2 : RATE_LIMITED_MS);
        this.notBefore = now + (after ?? this.backoff.limited);
        return;
      }
      if (!response.ok) {
        this.failed(now);
        return;
      }
      const json: unknown = await response.json();
      // A response for an account that is no longer Pi's is dropped.
      const current = await this.deps.token().catch(() => undefined);
      if (!current || codexAccountId(current) !== account) return;
      this.backoff = { limited: 0, failed: 0 };
      this.deps.record(readCodexUsage(json, this.deps.now()));
    } catch {
      this.failed(this.deps.now());
    } finally {
      clearTimeout(timer);
    }
  }

  private failed(now: number) {
    this.backoff.failed = Math.min(MAX_BACKOFF_MS, this.backoff.failed ? this.backoff.failed * 2 : FAILED_MS);
    this.notBefore = now + this.backoff.failed;
  }
}
