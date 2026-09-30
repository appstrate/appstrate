# Chat latency benchmark

Measures a chat turn the way a user lives it — from `POST /api/chat` (or the
composer's Enter key, in a real Chromium) to the first word on screen and the
end of the answer — and splits the time into platform overhead and model time.

It boots its **own** platform process from any checkout (a worktree per
variant), on its own port, against its own PostgreSQL 16 / Redis 7 / MinIO stack
(`docker-compose.bench.yml`, compose project `appstrate-bench`, host ports
55432 / 56379 / 59000), with an env built from scratch: the booted process never sees a developer's
`.env`, dev server or data (only `--upstream real` reads the provider keys from
`.env`, see below). The env file handed to the process holds provider keys and
is deleted as soon as the process has booted (or failed to).

## Quick start

```sh
# baseline on this checkout, a variant in a worktree, the baseline again
bun run bench:chat --label base --net-latency 5
bun run bench:chat --checkout ../wt-fix --label fix --net-latency 5
bun run bench:chat --label base-end --net-latency 5
bun run bench:chat:compare claudedocs/bench/chat/base.json claudedocs/bench/chat/fix.json claudedocs/bench/chat/base-end.json
```

Results land in `claudedocs/bench/chat/<label>.json` (gitignored; `--out <dir>`
picks another directory): every turn's raw timings, the platform's own phase
logs joined to it, what the upstream received, and per-scenario summaries
(median, p90, mean, min, max). Each boot's server log stays in
`.work-<label>-<time>/` beside it.

## Scenarios (`--scenarios`, comma-separated)

| scenario    | what it reproduces                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `cold`      | first message after a deploy/restart: a fresh process per turn                                                         |
| `warm-new`  | warmed process, each turn opens a new conversation                                                                     |
| `follow-up` | warmed process, one conversation turn after turn (the history grows)                                                   |
| `idle`      | warmed process, a new conversation after `--idle-gap` ms (default 45 s): in-process caches and idle connections expire |
| `ui`        | warmed process, the message typed into the SPA in headless Chromium; the page timestamps what is on screen (mock only) |

Default: `cold,warm-new,follow-up`. `--runs` measured turns per scenario (8),
`--warmup` discarded turns first (2). A setup boot before the first scenario
applies the migrations and signs the bench user up, so no measured boot or turn
pays for either. `/api/chat` allows 20 turns a minute per user, so turns are
paced `--min-interval` ms apart (3500; 3000 at least).

## Making it production-like

- **Data tier**: `--infra prod-like` (default) is PostgreSQL + Redis + MinIO, the
  production shape. `--infra pglite` is the zero-install tier. Each run starts
  from a fresh stack and removes it (volumes included) at the end;
  `--keep-infra` reuses a running stack and leaves it up, which saves the
  startup between runs but carries data over from one run to the next.
- **Round-trip cost**: on a laptop a loopback query is nearly free, which hides
  every serial await. `--net-latency <ms>` puts a TCP relay (`latency-proxy.ts`)
  in front of PostgreSQL and Redis that delays every packet by that one-way
  latency. **Calibration: `--net-latency 5` reproduced production's phase
  timings on 2026-09-27** (`claimTurnMs` ≈ 50–95, `phaseBMs` ≈ 250–320,
  `mcpHandshakeMs` ≈ 210–250). Calibrate again against production's
  `chat preamble` / `chat turn construction` log lines when the deployment
  changes. It reproduces round trips, not production's CPU load.
- **Upstream**: `--upstream mock` (default) is `mock-llm.ts`, an
  OpenAI-compatible server streaming a fixed profile behind the aliased
  `appstrate-model` production uses, so two builds differ only by the platform.
  `--mock-profile` merges JSON into the default: `ttfbMs`,
  `reasoningMsByEffort` (keyed by the `reasoning_effort` the platform sends),
  `textTokens`, `tokensPerSecond`, `markdown` (paragraphs and lists, for the
  `ui` scenario). The mock also records what it received (`reasoning_effort`,
  `max_tokens`, body size, tool count) and when. `--upstream real` uses
  `BENCH_SYSTEM_PROVIDER_KEYS`, else `SYSTEM_PROVIDER_KEYS` from the
  repository's `.env`, and measures the real model and network.
- **Request body**: `--body '{"generation":{"reasoning_level":"low"}}'` merges
  fields into every turn's body (the composer's generation settings, skills…).
- **Platform env**: `--env KEY=value` (repeatable). The result file records
  the keys, never the values.

## Metrics

Client side, ms after the request: `headers`, `firstVisible` (first reasoning or
text delta), `firstText`, `end`. Joined from the platform's own logs:
`preamble`, `phaseA`, `phaseB`, `claimTurn` (`chat preamble`), `mcpHandshake`,
`construction`, `firstModelEvent` (`chat turn construction`), `llmProxyTtfb`
(`llm-proxy call`). From the mock: `toUpstream` (platform time before the model
is even asked) and `relay` (upstream token → client).

`ui` scenario, ms after the SPA sent the turn: `dots` (thinking indicator),
`firstText`, `blank` (time before the first answer word with nothing moving on
screen), `lastText`, and render smoothness during the stream
(`longTaskMs`, `slowFrames` > 50 ms, `maxFrame`). `dots` is the element marked
`data-testid="chat-thinking-status"` (1.0.0-beta.64 and later). It serves the checkout's
`apps/web/dist` — build it first (`cd apps/web && bunx vite build`) — and drives
the Playwright of `e2e/` (`cd e2e && npx playwright install chromium`).

`bench:chat:compare` prints, per scenario, each metric's median in the baseline
(the first file) and in each variant, the delta, and a two-sided Mann-Whitney
p-value (exact for small tie-free samples); `*` marks p < 0.05, and `n` is the
number of completed turns on each side. `--metrics` picks the metrics.

## Rules for trustworthy numbers

- **A quiet machine.** Nothing else CPU-heavy while a bench runs — test suites,
  builds, other agents: they shift every metric by hundreds of ms and
  manufacture regressions.
- **Baseline at the start and at the end** of a series, compared with each
  other before anything else: their gap is the drift of the session (±40 ms
  observed), and a variant's delta smaller than it is not a result.
- Compare only variants measured in the same session, and treat a delta
  without `p < 0.05` as noise. A comparison tests dozens of metrics at once, so
  an isolated `*` is expected by chance: repeat the series before believing it.
- A run that stopped early (a failed boot, Ctrl-C) still writes its file, with
  `"complete": false`; `compare` flags it.
