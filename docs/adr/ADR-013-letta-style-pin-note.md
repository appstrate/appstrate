# ADR-013 — Letta-style `pin` + `note` tool surface

**Status**: Accepted
**Date**: 2026-04-25
**Supersedes**: tool-naming aspects of ADR-012

## Context

ADR-012 (memory-as-tool) split the unified `package_persistence` table
into the orthogonal `(key, pinned)` storage attributes — three of the
four reachable quadrants are agent-writable today, but the surface
exposed two oddly-named tools:

- `add_memory(content, scope?)` — archive-only writes (`key=null,
pinned=false`).
- `set_checkpoint(data, scope?)` — special-cased single named pinned
  slot (`key='checkpoint', pinned=true`).

`set_checkpoint` is a hardcoded single-slot tool that does not generalise
to the named pinned blocks the storage already supports. The vocabulary
also drifts from the canonical agent-memory literature: Letta / MemGPT
talk about `core_memory_replace(label, content)` + `archival_memory_*`
operations, not "checkpoints" and "memories." For the agent the right
mental model is **two tiers** (working set vs. archive), not "one
checkpoint slot vs. unstructured memories."

Production agent runs after ADR-012 also confirmed the rename gap:
agents kept asking "should I store X as a memory or a checkpoint?"
because the naming did not telegraph the actual difference (archive vs.
pinned).

## Decision

Adopt a Letta-style two-tool surface for memory writes:

- **`note(content, scope?)`** — replaces `add_memory`. Append to the
  archive tier. Reachable only via `recall_memory`. Not rendered into
  the system prompt.
- **`pin(key, content, scope?)`** — replaces `set_checkpoint`,
  generalised. Upsert-by-`key` into a named pinned slot. Last-write-wins
  per `(scope, key)`. Pinned content is rendered into the system prompt
  on every run. The legacy carry-over checkpoint is just one valid key:
  `pin({ key: "checkpoint", content })`. Other keys (e.g. `"persona"`,
  `"goals"`) are first-class and persist as named pinned blocks.

`recall_memory({ q?, limit? })` (introduced in ADR-012) stays unchanged.

### Key validation

Pinned slot keys are validated against the AFPS pin tool schema:

- ≤ 64 characters
- Pattern: `^[a-z0-9_]+$` (lowercase, digits, underscores)
- `"checkpoint"` is reserved for the legacy carry-over slot

The platform's `upsertPinned` enforces the same validation at the storage
boundary so a malformed agent payload fails loud rather than silently
corrupting `package_persistence`.

### Event-type rename

The canonical event vocabulary follows the tool rename:

- `memory.added` — kept (emitted by `note`). Same shape as before
  (`{ content, scope? }`).
- `pinned.set` — **NEW** (emitted by `pin`), shape `{ key, content,
scope? }`. Replaces `checkpoint.set` entirely; the legacy event type
  is dropped (no compat alias).

The runtime reducer aggregates `pinned.set` events into a new
`RunResult.pinned: Record<string, { content, scope? }>` map. For
backward compatibility with downstream consumers that read
`RunResult.checkpoint` directly, the reducer mirrors `pinned['checkpoint']`
into the top-level `checkpoint` field. The `checkpoint` field is
therefore a stable shorthand, not a separate aggregation path.

## Why drop `checkpoint.set` entirely

ADR-011 already announced the AFPS 1.4 break. ADR-012 already broke the
storage layout. We are on a feature branch with no production data and
agents will be redeployed with new bundles that import the renamed
tools. Keeping a `checkpoint.set` compat alias would buy nothing
(external runners are version-pinned per ADR-011) at the cost of two
event handlers, two reducer cases, and a long-tail "which one
should I emit?" question for new SDKs.

## Why not keep `set_checkpoint` as an alias of `pin('checkpoint', …)`

Same reasoning. The system-package floor moved with ADR-011; consumers
have to update their `dependencies.tools[]` anyway to pick up AFPS 1.5.
Keeping the alias would freeze the old vocabulary in public surfaces
forever; replacing it cleanly is one PR.

## Why named pinned slots beyond `checkpoint`

The storage layer (`package_persistence.key`) already supported any
non-null key after ADR-012. Wiring `pin(key, ...)` is the agent-facing
half of that capability — without it, the column existed but the agent
could not address slots beyond `checkpoint`. Concrete near-term cases:

- `persona` — stable agent identity across runs (Letta core-memory
  pattern).
- `goals` — current objectives; updated on review, read on every run.
- `user_preferences` — durable user-specific config the agent learned
  once and never wants to re-discover.

None of these are pseudo-checkpoints; they are first-class pinned
blocks. The reducer renders them in the same `## Memory` /
`## Checkpoint` sections of the prompt (ADR-012 always-emit rule)
without privileging the `checkpoint` key beyond the legacy mirror.

## Consequences

**Good**

- Agent vocabulary aligns with the SOTA literature (Letta / MemGPT
  core/archival split). Less "which tool?" friction in agent prompts.
- `pin` is one tool not three — `pin(key, content)` covers carry-over
  state, persona, goals, and any future named pinned slot. Adding a
  fifth named slot is zero-code.
- Storage column shape (`key + pinned`) is fully exposed via the agent
  surface. No more "expressive schema, narrow tool wrapper."
- `RunResult.pinned: Record<string, …>` makes the multi-slot aggregate
  legible to platform consumers (UI, audit log, …) without parsing the
  event stream.

**Bad / breaking**

- AFPS bundles that imported `@appstrate/add-memory` /
  `@appstrate/set-checkpoint` system packages need to update
  `dependencies.tools[]` to `@appstrate/note` / `@appstrate/pin`. The
  old packages are deleted from the Appstrate system-package set in
  this commit.
- Downstream tooling (CLI runners, observability sinks) that pattern-
  matched `event.type === "checkpoint.set"` must update to
  `event.type === "pinned.set"`. There is no compat alias.
- `RunResult.checkpoint` is now a derived view of
  `RunResult.pinned['checkpoint']` rather than an independent field.
  Downstream readers that only consult `result.checkpoint` keep working
  unchanged — but writers that synthesise a `RunResult` for testing must
  remember the reducer mirrors them, not the writer.

**Out of scope (kept for later)**

- TTL / decay on archive memories.
- Ranking by usage frequency.
- pgvector / semantic retrieval for `recall_memory`.
- Agent-controlled pinning via `note({ pin: true })` — Letta keeps the
  two operations (write-archive vs. write-pinned) cleanly separate, so
  we follow suit.
- A `recall_pinned({ key })` for reading pinned slots back from the
  agent — the existing prompt rendering already exposes them on every
  run, so the read path is implicit.

## Implementation references

- Tool definitions: `packages/afps-runtime/src/resolvers/platform-tools.ts`
  (`noteTool`, `pinTool`, `PLATFORM_TOOLS`).
- Event types: `packages/afps-runtime/src/types/canonical-events.ts`
  (`MemoryAddedEvent`, `PinnedSetEvent`, `CANONICAL_EVENT_TYPES`).
- Reducer: `packages/afps-runtime/src/runner/reducer.ts` (`pinned.set`
  fold, checkpoint mirror).
- RunResult shape: `packages/afps-runtime/src/types/run-result.ts`
  (`pinned`, `PinnedSlot`).
- Storage: `apps/api/src/services/state/package-persistence.ts`
  (`upsertPinned`, `PINNED_KEY_PATTERN`, `MAX_PINNED_KEY_LENGTH`).
- Ingestion: `apps/api/src/services/run-event-ingestion.ts` (iterates
  `result.pinned` and writes each named slot via `upsertPinned`).
- Finalize ingestion validation:
  `apps/api/src/routes/runs-events.ts` (`RunResultSchema` accepts
  `pinned` + `checkpointScope`).
- System packages: `scripts/system-packages/tool-note-1.0.0/`,
  `scripts/system-packages/tool-pin-1.0.0/` (replace
  `tool-add-memory-*` and `tool-set-checkpoint-*`).
- Prompt rendering: `packages/afps-runtime/src/bundle/platform-prompt.ts`
  (memory section references `note`, `pin({ key, content })`,
  `recall_memory`).
- Tests: `packages/afps-runtime/test/resolvers/platform-tools.test.ts`,
  `packages/afps-runtime/test/types/canonical-events.test.ts`,
  `packages/afps-runtime/test/sinks/{console-sink,reducer-sink}.test.ts`,
  `runtime-pi/test/tee-sink.test.ts`,
  `apps/api/test/integration/services/{appstrate-event-sink,parity-e2e}.test.ts`,
  `apps/api/test/unit/prompt-builder.test.ts`.

## Sources

- Letta / MemGPT — `core_memory_replace` / `archival_memory_*` two-tier
  split; named blocks for stable agent state.
- Mem0 — short-term / long-term / semantic tiers; the rename clarifies
  which tier each tool writes to.
- ADR-011 — checkpoint unification floor (`AFPS 1.4` break).
- ADR-012 — memory-as-tool decision; this ADR completes its rename.
