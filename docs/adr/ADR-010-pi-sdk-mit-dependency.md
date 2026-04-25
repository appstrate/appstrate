# ADR-010: Pi SDK (MIT) as the Default Agent Session Backend for `@appstrate/afps-runtime`

## Status

Accepted

## Context

`@appstrate/afps-runtime` executes AFPS agents by driving an underlying "agent session" — the component that sends prompts to an LLM, handles tool calls, and streams events. Appstrate already uses [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono) (the "Pi SDK") inside `runtime-pi` today, and it is the most complete fit for the Appstrate use case.

The runtime package targets an Apache-2.0 open-source license. Bundling or linking against a non-permissively-licensed SDK would either block the Apache-2.0 release or force it behind a non-free fence. Before committing the ecosystem to Pi SDK, the dependency chain needed a license audit.

Requirements:

- Default agent session backend compatible with Apache-2.0 distribution
- No copyleft surprises in the transitive dependency tree of `@appstrate/afps-runtime`
- Path to swap the backend out later without breaking the runtime's public API (second agent SDK, future ecosystem choice)

Alternatives considered:

- **No default backend, require consumers to provide one**: increases friction for the 95% case (Appstrate users and casual adopters); an OSS runtime should "just work" out of the box
- **Write a minimal agent session from scratch**: premature — Pi SDK already solves tool invocation, retries, streaming, session state, token accounting
- **Bundle a different SDK** (Claude Agent SDK, OpenAI Agents SDK, Vercel AI SDK): all workable, but none already integrated with Appstrate's current runtime; switching cost is high with no immediate user benefit

## Decision

Ship Pi SDK as the **default `AgentSessionProvider`** inside `@appstrate/afps-runtime`. The SDK surface is encapsulated inside a single `PiSessionProvider` adapter; nothing else in the runtime imports Pi SDK directly.

License audit (2026-04-20) confirmed:

| Package                          | License                    | Source                              |
| -------------------------------- | -------------------------- | ----------------------------------- |
| `@mariozechner/pi-coding-agent`  | MIT                        | `package.json` + upstream `LICENSE` |
| `@mariozechner/pi-ai`            | MIT                        | `package.json`                      |
| `@mariozechner/pi-agent-core`    | MIT                        | `package.json`                      |
| `@mariozechner/pi-tui`           | MIT                        | `package.json`                      |
| Upstream repo `badlogic/pi-mono` | MIT (standard, unmodified) | GitHub LICENSE file + API           |

MIT is fully compatible with Apache-2.0 under standard redistribution hygiene: preserve the MIT copyright notices in a `NOTICE` file at distribution. No CLA, no "non-commercial" clause, no dual-licensing twist.

To preserve flexibility, the runtime defines an `AgentSessionProvider` interface (a reserved extension point, fully implemented only for Pi SDK at v1). Future adapters (Claude Agent SDK, OpenAI Agents SDK, etc.) can plug in without breaking the runtime API — driven by user demand, not speculation.

## Consequences

**Positive:**

- `@appstrate/afps-runtime` ships Apache-2.0 with zero license compromise
- Reuses a mature, battle-tested agent session implementation — avoids rewriting tool invocation, retries, streaming, session state
- `AgentSessionProvider` interface exists from day one; swapping backends stays a surgical change rather than an architectural one
- Pi SDK's MIT license means forking is always an option if upstream direction diverges

**Negative:**

- Pi SDK is currently solo-maintained (Mario Zechner) — single-maintainer risk, not license risk
- Pre-1.0 (`0.67.x`) versioning means minor bumps may break; runtime pins to `~0.67.2` or exact `0.67.2` rather than `^0.67.2`
- MIT provides no explicit patent grant (Apache-2.0 does for the runtime's own code) — standard industry pattern, theoretical risk only

**Neutral:**

- `NOTICE` file in `packages/afps-runtime/` ships the MIT attributions required for redistribution
- If demand for a second SDK materializes (Phase 11+ of the runtime plan), `AgentSessionProvider` is the agreed extension point — no renegotiation of the runtime's public API
