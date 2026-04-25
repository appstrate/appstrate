# ADR-012 — Memory as a tool, not as prompt injection

**Status**: Accepted
**Date**: 2026-04-25
**Supersedes**: parts of ADR-011 (memory-as-prompt-injection behaviour)

## Context

After ADR-011 unified `runs.state` + `package_memories` into a single
`package_persistence` table with `kind ∈ {checkpoint, memory}`, both
primitives were rendered into the agent's system prompt on every run.
For checkpoints (one row per scope) this is cheap. For memories
(append-only, capped at 100 per scope, ~2KB each) the worst-case prompt
overhead approaches **50K tokens before the agent has done any work**.

The 2026 SOTA on agent memory (Anthropic's memory tool, OpenClaw,
Letta/MemGPT, Mem0, LangMem) converges on a hot/cold split: a small
working set always in context + a larger archive reachable via tool
calls. Production agent test runs on this branch confirmed the cost
is real — the LLM happily reads everything we inject, but doesn't
need most of it on most runs.

## Decision

Replace the `kind` enum with two orthogonal storage attributes and
expose archive memories through a dedicated MCP tool:

1. **DB schema** (migration `0011_persistence_unify`):
   - Drop `kind`.
   - Add `key TEXT NULL` — when set, row is upsert-by-key (single
     "named slot"); when null, row is append-only.
   - Add `pinned BOOLEAN NOT NULL DEFAULT false` — when true, row is
     rendered into the system prompt; when false, row is reachable
     only via `recall_memory`.
   - The legacy mapping is mechanical:
     `kind='checkpoint'` ≡ `key='checkpoint'`, `pinned=true`.
     `kind='memory'` ≡ `key IS NULL`, `pinned=false`.

2. **Agent-facing tools** (wire-format unchanged):
   - `set_checkpoint(data, scope?)` — writes `{key:'checkpoint', pinned:true}`.
   - `add_memory(content, scope?)` — writes `{key:null, pinned:false}`.
     **Default flips**: archive, not prompt. Existing AFPS callers
     receive the same `Memory saved` ack but their memory no longer
     auto-injects on the next run.
   - `recall_memory({ q?, limit? })` — **new** MCP tool. Searches the
     archive (case-insensitive substring on content). Returns
     `{ memories: [...] }`.

3. **Prompt rendering** (`packages/afps-runtime/src/bundle/platform-prompt.ts`):
   - The `## Memory` section is **always emitted**, even when nothing
     is pinned. It lists pinned memories (none, currently — no agent
     path writes pinned memories yet) and explicitly tells the agent
     `recall_memory` is available for the archive. This is what makes
     the LLM discover the tool consistently.

4. **Platform plumbing**:
   - New service: `recallMemories(packageId, applicationId, scope, { query?, limit? })`
     in `apps/api/src/services/state/package-persistence.ts`. Caps at
     50 rows per call. ILIKE on `content::text` — flat substring,
     no embeddings. Sorted `createdAt DESC, id DESC` for stable order.
   - New service: `listPinnedMemories(...)` — what the prompt builder
     reads instead of `listMemories`.
   - New route: `GET /internal/memories?q=&limit=` (run-token
     authenticated, like `/internal/run-history`).
   - New sidecar MCP tool: `recall_memory` in `runtime-pi/sidecar/mcp.ts`.
   - New runtime-pi extension: `makeRecallMemoryExtension` in
     `runtime-pi/extensions/mcp-direct.ts`.

## Why not pgvector / embeddings (the "Option C" delta)

Vector retrieval is the obvious next step but introduces an embedding
write path on every `add_memory`, an embedding column + index, and a
new dependency. Substring search via ILIKE is enough for the cardinality
we cap memories at (100 per scope) and avoids the operational cost.
The unified schema (`key + pinned`) lets us bolt on `embedding` later
without another migration: add a column, populate on write, switch the
query in `recallMemories`. The `recall_memory` tool surface stays
identical from the agent's perspective.

## Why default `pinned=false` on `add_memory`

The alternative — keeping all memories pinned by default with a sliding
window — perpetuates the "agent doesn't have to think about retrieval"
posture. The whole point of the move is to align the agent's mental
model with how the platform actually exposes memory: as a queryable
store, not as a free side channel into the prompt. Forcing the agent
to use `recall_memory` is the discipline that makes the abstraction
honest. Adding a `pin: true` parameter to `add_memory` later is
non-breaking; we don't need it yet.

## Why drop `kind` rather than keep it as a hint

Once `key + pinned` exists, `kind` is redundant. Keeping it would mean
every read path has to assert that `kind='memory' ⇒ key IS NULL` etc.
— the kind of cross-column invariant that drifts. One source of truth
is cheaper than two-with-a-check.

## Consequences

**Good**

- Prompt overhead drops from O(N≤100 × 2KB) to O(0) for archive
  memories. Working set is just the checkpoint plus future pinned
  rows.
- The LLM discovers `recall_memory` from the prompt section + the MCP
  tool list — both are explicit and self-documenting.
- The schema is more expressive than the old enum: future named slots
  (e.g. `key='user_preferences'`) are a one-line write away, no
  migration needed.
- Adding pgvector later is a column + an index, not a refactor.

**Bad / breaking**

- Existing AFPS agents that relied on memories auto-injecting will
  silently lose visibility unless they are updated to call
  `recall_memory` (or the prompt template is updated to reference
  the archive). Acceptable on this branch because there is no prod
  data and the AFPS 1.4 floor was already a breaking-change
  checkpoint (ADR-011).
- One more MCP tool in every container — flat overhead, no per-run
  cost.

**Out of scope (kept for later)**

- TTL / decay on archive memories.
- Ranking by usage frequency.
- pgvector / semantic retrieval.
- Agent-controlled pinning via `add_memory({ pin: true })`.
- Named slots beyond `checkpoint` (e.g. `user_preferences`).

## Implementation references

- DB: `packages/db/drizzle/0011_persistence_unify.sql`,
  `packages/db/src/schema/runs.ts` (`packagePersistence`).
- Service: `apps/api/src/services/state/package-persistence.ts`.
- Route: `apps/api/src/routes/internal.ts` (`GET /internal/memories`).
- Sidecar tool: `runtime-pi/sidecar/mcp.ts` (`recallMemory`).
- Runtime adapter: `runtime-pi/extensions/mcp-direct.ts`
  (`makeRecallMemoryExtension`).
- Prompt rendering: `packages/afps-runtime/src/bundle/platform-prompt.ts`.
- Tests: `apps/api/test/integration/routes/internal.test.ts`
  (`GET /internal/memories` block),
  `runtime-pi/sidecar/test/mcp.test.ts` (`recall_memory` tool/list +
  tool/call), `runtime-pi/test/mcp-direct.test.ts` (recall_memory
  dispatch), `packages/afps-runtime/test/bundle/platform-prompt.test.ts`
  (always-emit + pinned listing).

## Sources

- Anthropic — _Effective context engineering for AI agents_ (memory
  tool, just-in-time retrieval).
- OpenClaw memory strategy — tool-driven RAG, on-demand recall.
- Letta / MemGPT — core / archival / recall memory tiers.
- Mem0 — three-scope memory + compression engine.
- LangMem — episodic / semantic / procedural primitives, hot-path
  tool calls.
