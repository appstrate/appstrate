# Unified Pi Chat — measurement archive (August 2026)

**Status: archive.** This directory records the measurements that justified
moving chat onto the in-process Pi engine. It is evidence, not a live design
reference — for how chat runs today, read the code and
[`../SUPPLY_CHAIN.md`](../SUPPLY_CHAIN.md).

The campaign ran on a branch that compared **two** chat inference loops: the AI
SDK loop (API-key models) against the in-process Pi engine (OAuth subscriptions).
That comparison no longer has a second arm: #1173 retired the AI SDK loop and
every chat turn now runs on Pi. The numbers below are therefore historical —
they are why the split was closed, not a claim about the engine that ships.

Everything the campaign produced as code shipped separately, in the split PRs
listed under [Where the work landed](#where-the-work-landed). Nothing here is
pending.

## What was measured

Local, on an Apple M2, against isolated synthetic databases (PGlite, and one
throwaway PostgreSQL database per cell). No production account or content was
touched. A wave of N chats starts every conversation inside a 250 ms window —
a deliberately severe burst, chosen to expose contention, not to model normal
traffic.

### Controlled replay on isolated PostgreSQL

Medians of the p95 across three warm repetitions per cell, at commit `56706ae7`.
1 590 of 1 590 conversations completed: no 429, no server error, no incomplete
stream, no wrong marker. Model calls, tokens, messages, structured parts and
usage rows all matched expectations; continuity and isolation passed; every
synthetic database was dropped afterwards.

| Concurrency | Engine | p95 first token | p95 total |    Throughput |
| ----------: | ------ | --------------: | --------: | ------------: |
|          60 | AI SDK |          355 ms |    593 ms | 89.74 chats/s |
|          60 | Pi     |          656 ms |    880 ms | 64.37 chats/s |
|          64 | AI SDK |          754 ms |  1 148 ms | 52.39 chats/s |
|          64 | Pi     |          874 ms |  1 313 ms | 45.91 chats/s |
|         100 | AI SDK |        1 052 ms |  1 548 ms | 61.08 chats/s |
|         100 | Pi     |        1 530 ms |  1 882 ms | 46.51 chats/s |

The gap is **not** a slow Pi cycle. At 100 chats, Pi's own work between entering
the engine and issuing the prompt costs 8.4 ms at p95. The delay forms earlier,
in event-loop contention: the first Pi turns do synchronous work while later
turns wait on their PostgreSQL writes. Loop delay p95 was 96 ms for Pi against
25 ms for AI SDK, and wave CPU 3.10 s against 2.54 s.

Memory recovered in both engines. Pi went 239.6 MiB RSS at start → 324.9 MiB
peak → 95.8 / 85.7 / 85.8 MiB after 30 / 60 / 120 s; AI SDK 147.2 → 279.3 →
65.0 / 158.4 / 52.9 MiB. Pi carries roughly 92 MiB more fixed load, but grew
less between start and peak in that cell (~85 MiB against ~132 MiB).

### Real provider comparison — Mistral

Warm, 60 concurrent chats, one repetition, `mistral-small-2603`, through the
real endpoint: auth, model selection, proxy and ledger included.

| Engine | p95 first token | p95 total |    Throughput |
| ------ | --------------: | --------: | ------------: |
| AI SDK |        2 771 ms |  2 910 ms | 13.39 chats/s |
| Pi     |        2 803 ms |  3 157 ms |  9.24 chats/s |

All 120 conversations completed cleanly. The 32 ms first-token difference is
provider-dominated and imperceptible; the throughput difference under saturation
is real and is a sizing input, not a latency one.

### Subscriptions

Measured at commit `c5a35b2d`, **before** the Pi 0.84.2 upgrade — kept as
history, not as a measurement of what shipped. Each subscription completed 41 of
41 conversations, with persistence, usage, continuity and isolation passing.

| Subscription           | Concurrency | p95 first token | p95 total |   Throughput |
| ---------------------- | ----------: | --------------: | --------: | -----------: |
| Codex, GPT 5.6 Luna    |           1 |        1 962 ms |  2 184 ms |  0.46 chat/s |
| Codex, GPT 5.6 Luna    |          10 |        2 888 ms |  3 124 ms | 3.19 chats/s |
| Codex, GPT 5.6 Luna    |          30 |        3 589 ms |  3 784 ms | 7.65 chats/s |
| Claude Code, Haiku 4.5 |           1 |        2 316 ms |  2 344 ms |  0.43 chat/s |
| Claude Code, Haiku 4.5 |          10 |        2 506 ms |  2 540 ms | 3.93 chats/s |
| Claude Code, Haiku 4.5 |          30 |        3 359 ms |  3 377 ms | 8.83 chats/s |

Level 60 was not run: no subscription policy explicitly permits that burst.

The Pi 0.84.2 subscription paths were validated functionally instead, under
`RUN_ADAPTER=docker`, with runtime and sidecar built from the same worktree —
Claude Code and Codex inline runs both `success`, usage and a single terminal
event persisted, no `adapter_error`, no container left running.

## What the campaign found and fixed

Five costs specific to the Pi path were isolated. All five fixes shipped:

1. **`ModelRuntime.create()` refreshed the whole model catalog every turn.** The
   model is resolved upstream now; runtime creation stays under 1 ms median up
   to 100 conversations.
2. **The inert `proxy` auth placeholder triggered a full credential sync.** Its
   synchronous path now costs ~0.1–0.2 ms. Codex and Claude Code OAuth
   credentials keep their full sync.
3. **`DefaultResourceLoader.reload()` rescanned local resources per
   conversation** — skills, extensions and context files that chat's policy does
   not expose at all. Chat uses a loader scoped to the turn's prompt and inline
   extensions; reload p95 fell from 53.2 ms to 2.3 ms at 30 conversations. This
   was the single biggest win: a CPU profile attributed **47.7 %** of the Pi wave
   to that synchronous discovery, and removing it took Pi's first-token p95 from
   1 243 ms to 267 ms at 30 chats. The Pi *runtime* keeps full discovery.
4. **A deliberate cancellation after the terminal `output` tool could be
   classified as an error.** Pi 0.84.2 can normalise it to `stopReason: "error"`
   with the standard message `The operation was aborted.`. The bridge now
   recognises that exact shape as a normal end — only after a terminal tool
   succeeded, so ordinary provider errors stay errors.
5. **Pi 0.84.2 moved its OpenAI-compatible cache-token normalisation.** The
   anchor test follows the shipped file, and the adapter keeps the same
   input / cache-read / cache-write split.

The Pi→client stream mapper was measured at 0.05–0.15 ms and was **not** a cause.

One operational constraint came out of the Docker validation: an older sidecar
image failed Codex with `400 Bad Request` and zero model calls while Claude Code
passed. Runtime and sidecar must be built and deployed as one coherent set.

## Limits — read before quoting any number

- **These are local numbers.** Apple M2, synthetic databases, synthetic bursts.
  They do not establish Appstrate Cloud capacity, and must never be presented as
  such. Per-replica CPU and memory, replica count, autoscaling, restarts, real
  p95/p99 active chats, and real token and tool distributions were all unknown.
- **Some cells are exploratory.** The targeted bench and the Mistral pair carry
  one repetition each; only the PostgreSQL replay has three.
- **The default Pi concurrency ceiling stays 6** until cloud capacity is
  measured. A policy test with the ceiling pinned to 64 and 100 requested admits
  exactly 64 and returns 36 clean 429s with `Retry-After` and no orphan message.
  Measuring `CHAT_PI_MAX_CONCURRENCY` on a real instance is the open follow-up —
  see [`../../plans/post-pi-unification-cleanup.md`](../../plans/post-pi-unification-cleanup.md), item 1.

## Versioned evidence

- [Observation schema](./performance-observation.schema.json) — the shape the
  harness emitted, and what the result files below conform to.
- [Compact summary](./performance-results/2026-08-19-unified-pi-pr-summary.v1.json)
  — every table above, machine-readable.
- [Advanced chat functional proof](./performance-results/2026-08-19-pi-advanced-chat-functional.v1.json)
  — a Pi chat launching an inline run, creating a document, reading it back by
  URI from two other sessions, and keeping session continuity.
- [Docker subscription smoke](./performance-results/2026-08-19-pi-docker-subscription-smoke.v1.json)
  — the two `RUN_ADAPTER=docker` subscription runs.

Raw per-cell observations, PGlite databases and CPU profiles were never in git.

## Where the work landed

The campaign branch was split into these PRs, all merged:

| PR    | What                                                             |
| ----- | ---------------------------------------------------------------- |
| #1166 | Sidecar forwards `/llm` request bodies byte-identically (zstd).   |
| #1167 | Pi SDK 0.84.2, and the `@earendil-works` npm scope move.          |
| #1168 | Chat history replayed as structured Pi messages, not a transcript.|
| #1170 | The stop button stops the server, not just the fetch.             |
| #1173 | Every chat turn runs on Pi; the AI SDK loop is gone.               |
| #1175 | The follow-ups the unification audit left open.                   |

#1164 — the campaign branch itself — was closed against these. #1169 was closed
in favour of #1173.

## Reproducing this

The A/B harness is **not** in the tree. It drives two engines through
`handleChatStream`, and one of them no longer exists — it cannot typecheck
against `main`, and its comparative arm has nothing to compare. It is preserved,
with its tests and its reproduction commands, on the archived campaign branch:

```sh
git fetch origin refs/tags/archive/chat-pi-unified-engine-phase4
git show archive/chat-pi-unified-engine-phase4:scripts/chat-engine-performance.ts
git show archive/chat-pi-unified-engine-phase4:docs/architecture/unified-pi-chat/README.md
```

That tag also holds the original French report this file condenses.

A Pi-only load harness — the thing actually needed to size the cloud — would be
new work, not a port. The invariants it must check are what made these numbers
trustworthy, and are worth keeping: a cell counts only if it completes the
requested conversations, with zero server errors, zero incomplete streams, the
expected model and tool call counts, tokens and usage rows persisted, messages
and structured parts persisted, session continuity intact, and no cross-tenant
row. That last one is one query:

```sql
SELECT count(*) AS cross_tenant_usage_rows
FROM llm_usage u
JOIN chat_sessions s ON s.id = u.chat_session_id
WHERE u.org_id IS DISTINCT FROM s.org_id
   OR u.user_id IS DISTINCT FROM s.user_id;
```

The expected answer is zero.
