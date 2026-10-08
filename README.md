# pi-auto-effort

A [pi](https://pi.dev) extension that sets the thinking level for each message you send, on the
model you chose. [Jev](https://docs.typesafe.ai), called through Pi's own classifier models
(`ctx.modelRegistry.classify`), rates how much careful reasoning the request needs, in about 100-250
ms before the turn starts:

| Score | Request | Level |
|---|---|---|
| 0 | a lookup, trivial answer, or mechanical change | low |
| 1 | a routine single-file change or clear question | medium |
| 2 | a multi-step change, debugging with clear symptoms, design in a known pattern | high |
| 3 | subtle design, cross-cutting refactor, hard debugging, correctness-critical work | xhigh |

Jev sees the request, the two before it, the last answer, and what the last run did (errors, files
edited, tool calls).

**Smoothing.** A running average `e = 0.5·score + 0.5·e_prev` moves the level up when it is at least
0.6 above it, and down when at least 0.6 below and the level has held for 2 messages. A confident
(>= 0.6) score 1.5 or more above the level jumps straight to it. A go-ahead ("yes", "continue", "do
it") keeps the level.

**Bounds.** Your latest manual level (`/thinking`, the shortcut, a model switch, or another
extension such as plan mode) is the ceiling; `low` is the floor. Levels below the floor (`off`,
`minimal`) are left alone.

**Cache-safe.** The level changes only before a message you send, never on tool follow-ups.
Auto-effort is off when Pi was started with `--thinking` (so a subagent's explicit effort stays
fixed), and it keeps the level when Jev is unavailable.

## Commands

- `/auto-effort` or `/auto-effort status`: current level, ceiling, average, last decision.
- `/auto-effort limits`: each window's use, elapsed share, projection, time to run out, reading
  age and tier (also part of `status`).
- `/auto-effort on`, `/auto-effort off`: for this session; off restores the ceiling.

The footer shows `effort: high (auto)`, or `effort: medium (auto, limited: 5h 84%)` while a limit
is in force (see Limits). Each decision is an `auto-effort:state` session entry (never
sent to the model); the state follows the session tree and is restored on resume.

## Limits

When an Anthropic or Codex subscription window (5h, weekly) is on track to run out before it resets, auto-effort lowers the thinking level one or two steps below what the request would otherwise get.

**Sources.** Anthropic subscription (OAuth) responses carry `anthropic-ratelimit-unified-5h-*`
and `-7d-*` headers (utilization, reset, status), read in `after_provider_response`; an API key
gets token-bucket headers instead, which are ignored, so it is never limited. Codex windows come
from `GET https://chatgpt.com/backend-api/wham/usage` (Pi's default WebSocket transport carries no
`x-codex-*` headers), polled only while a Codex model is in use, with the token and account Pi
itself sends: at most every 5 minutes, one request at a time, 5 s timeout, in the background (a
prompt never waits for it). A 429 waits for `Retry-After`, else 15 minutes doubling to an hour;
other failures wait 5 minutes doubling to an hour; a 401/403 stops polling until the token changes.

**Privacy.** Only response headers and Pi's own Codex credential are used; no auth files are read,
and the readings stay in memory (each process reads the same account-wide figures, so nothing is
shared or written to disk). Quota data never reaches Jev or the model.

**When it lowers the effort.** Each window gets a tier:

| Tier | Effort | At once when | After a second assessment 5 minutes later when |
|---|---|---|---|
| caution | 1 level down | 75% used | the forecast runs out before 90% of the time to reset (warming up: projected 100% at reset) |
| critical | 2 levels down | 90% used, the provider reports it exceeded, or the forecast runs out within 30 minutes | projected 150% at reset |

The worst window wins, and there is one cut in total. The cut never goes below `policy.floor`. A
tier lifts after two assessments 5 minutes apart with the projection at most 95% at reset (for
critical, under 145%) and use 5 points under the tier's threshold. A window that resets clears its
tier at once. Assessments happen at your prompts, so an idle session changes nothing.

**The forecast.** Two rates from the window's history of readings: a recent one (the last hour,
half-life 15 minutes; gaps over 30 minutes do not count) and a sustained one (the last 24 hours,
half-life 6 hours), each weighting an interval by its length and recency. The recent burst decays
toward the sustained rate over `tau = min(1 h, window / 5)`, and the forecast integrates that up to
the reset: near a 5h reset a burst dominates, across a week it fades. Until a window has 3 readings
spanning `min(1 h, window / 10)`, the linear pace (used divided by the fraction of the window
elapsed, as in CodexBar) stands in, from 10% elapsed and 20% used. A reading older than 15 minutes
still counts as a minimum (use only grows within a window) but not for the weighted forecast. A
spend limit has no length, so only its absolute thresholds apply.

**Not feeding back.** The policy's own pick (the baseline) is kept apart from the level applied, so
a limited stretch never drags the running average or the level down, and the baseline returns at
the next prompt once the pressure clears.

Settings, in the shared file:

```json
"limits": {
  "enabled": true,
  "caution":  { "used": 0.75, "projected": 1.0 },
  "critical": { "used": 0.90, "projected": 1.5, "exhaustMinutes": 30 },
  "steps": { "caution": 1, "critical": 2 },
  "exitProjected": 0.95,
  "hysteresis": 0.05,
  "confirmMinutes": 5,
  "staleMinutes": 15,
  "warmup": { "readings": 3, "spanMinutes": 60, "minElapsed": 0.1, "minUsed": 0.2 },
  "recent": { "lookbackMinutes": 60, "halfLifeMinutes": 15 },
  "sustained": { "lookbackHours": 24, "halfLifeHours": 6 }
}
```

On by default; `"limits": { "enabled": false }` in the shared `auto-effort.json` turns it off for
every port, and `/auto-effort off` turns it off with the rest for the session. An invalid value
falls back to its default.

## Settings

`~/.config/agents/auto-effort.json` (`$XDG_CONFIG_HOME` honored) and `<project>/.agents/auto-effort.json`
are shared with the opencode and Claude Code ports of this plugin; `~/.pi/agent/auto-effort.json` and
`<project>/.pi/auto-effort.json` are pi-only overrides. They are read in the order shared user, pi
user, shared project, pi project, each merged on top of the last (objects merge, other values
replace); keys a port does not know are ignored.

```json
{
  "enabled": true,
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 1500 },
  "policy": { "floor": "low", "alpha": 0.5, "margin": 0.6, "jump": 1.5, "jumpConfidence": 0.6, "minDwell": 2, "ackThreshold": 0.7 }
}
```

Requires Pi 0.99 or newer for classifier models.

## Development

```sh
npm run check   # typecheck and unit tests
npm run eval    # 20 requests against live Jev through the installed Pi (needs TYPESAFE_API_KEY)
```
