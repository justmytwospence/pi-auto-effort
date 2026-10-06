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
- `/auto-effort on`, `/auto-effort off`: for this session; off restores the ceiling.

The footer shows `effort: high (auto)`. Each decision is an `auto-effort:state` session entry (never
sent to the model); the state follows the session tree and is restored on resume.

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
