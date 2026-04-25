# ADR-011 — Checkpoint + Memory Unification

**Status**: Accepted (full implementation — phases 0-7 landed; legacy column drop deferred)
**Date**: 2026-04-24

## Summary

Appstrate historically carries two run-persisted agent primitives:

1. **`state`** — the `runs.state` JSONB column. Written by the `set_state`
   platform tool (`state.set` event), read as "Previous State" for the next
   run. Per-actor (user / end-user) because `runs` itself has actor columns.
2. **Memories** — the `package_memories` table. Written by the `add_memory`
   platform tool (`memory.added` event), rendered as "Memory" in the prompt.
   App-wide — no actor column, so every end-user of an application sees the
   same memories.

These two shapes are arbitrary. A stack that serves one end-user per run
(e.g. headless SaaS) genuinely wants both primitives to be **actor-scoped**:

- a user's preferences ("prefers CSV", "works at GMT+2") belong to that
  user, not leaking to the next end-user;
- a tactical checkpoint (next pagination cursor) already _is_ actor-scoped
  because it lives on `runs`.

At the same time, an OSS single-tenant stack sometimes genuinely wants both
primitives to be **shared** across actors:

- the "API v3 requires scope=email" discovery is universal knowledge;
- a cron-scheduled sync job has no actor and needs a shared checkpoint.

This PR unifies the two primitives into a single `package_persistence` table
with a first-class `scope` dimension, renames the user-facing `state` → `checkpoint`
where unambiguous, and keeps both legacy stores alive for a transition window.

## Final shape

```sql
CREATE TABLE package_persistence (
  id              TEXT PRIMARY KEY,
  package_id      TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  application_id  TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('checkpoint', 'memory')),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('user', 'end_user', 'shared')),
  actor_id        TEXT NULL,  -- NULL iff actor_type = 'shared'
  content         JSONB NOT NULL,
  run_id          TEXT NULL REFERENCES runs(id) ON DELETE SET NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One checkpoint per (package, app, actor): upsert target.
CREATE UNIQUE INDEX pkp_checkpoint_unique
  ON package_persistence (package_id, application_id, actor_type, COALESCE(actor_id, ''))
  WHERE kind = 'checkpoint';

-- Read path (getCheckpoint / listMemories).
CREATE INDEX pkp_lookup
  ON package_persistence (package_id, application_id, kind, actor_type, actor_id);

CREATE INDEX pkp_org ON package_persistence (org_id);
```

- **`kind = 'checkpoint'`** — one row per `(package, app, actor)`, upserted
  last-write-wins. Replaces `runs.state` semantics.
- **`kind = 'memory'`** — append-only list bounded at 100 per `(package, app, actor)`,
  content capped at 2000 chars. Replaces `package_memories` semantics.
- **`actor_type = 'shared'` with `actor_id = NULL`** — app-wide; every actor
  sees it. This is the migrated shape of every existing `package_memories` row.
- **`actor_type ∈ {'user', 'end_user'}` with `actor_id` set** — scoped. The
  migrated shape of every per-actor `runs.state` row.

## Read semantics

- `getCheckpoint(package, app, actor)` — tries actor-specific row, falls back
  to `shared`, returns `null` if neither. This gives headless multi-tenant
  applications per-end-user isolation by default while still letting the
  runtime ship universal checkpoints.
- `listMemories(package, app, actor)` — union of shared + actor-specific,
  sorted by `createdAt ASC`. The 100-per-actor cap is enforced _per scope_,
  not globally, so a shared catalog + per-user notes can coexist.

## Write semantics

- `upsertCheckpoint(package, app, actor, content, runId)` — `INSERT … ON
CONFLICT DO UPDATE` keyed on the unique index.
- `addMemory(package, app, actor, content, runId)` — bounded append.
- `scope` on the runtime tool (`add_memory` / `set_checkpoint`): defaults to
  `actor` (safer for multi-tenant headless). Agents opt into `shared` explicitly.

## Actor resolution

The run-level actor already lives in `runs.dashboard_user_id` / `runs.end_user_id`
(see `apps/api/src/lib/actor.ts`). The unification reuses that exact helper:

```ts
function actorFromRunContext(ctx: { userId?: string | null; endUserId?: string | null }): Actor {
  if (ctx.endUserId) return { type: "end_user", id: ctx.endUserId };
  if (ctx.userId) return { type: "member", id: ctx.userId };
  return { type: "shared" }; // scheduled runs, system runs, orphaned-actor runs
}
```

Note: the pre-existing `Actor` type (from `@appstrate/connect`) uses `member`
for authenticated dashboard users; the storage column uses `user` for brevity.
`actor_type = 'user'` in the DB maps to `Actor.type = 'member'` in TypeScript.

## Audit — current hotspots

Backend (Node/Bun) files touched by the legacy primitives:

| File                                              | What it does                             |
| ------------------------------------------------- | ---------------------------------------- |
| `packages/db/src/schema/runs.ts`                  | Declares `runs.state`, `packageMemories` |
| `apps/api/src/services/state/runs.ts`             | `getLastRunState`, `updateRun({state})`  |
| `apps/api/src/services/state/package-memories.ts` | CRUD helpers                             |
| `apps/api/src/services/env-builder.ts`            | Reads both for prompt injection          |
| `apps/api/src/services/run-event-ingestion.ts`    | Writes both on finalize                  |
| `apps/api/src/routes/agents.ts`                   | `GET/DELETE /memories` routes            |
| `apps/api/src/routes/internal.ts`                 | `run_history` tool exposing `state`      |
| `apps/api/test/helpers/db.ts`                     | Truncation list                          |

Runtime + tools:

| File                                                    | What it does                              |
| ------------------------------------------------------- | ----------------------------------------- |
| `packages/afps-runtime/src/resolvers/platform-tools.ts` | `memoryTool`, `stateTool` definitions     |
| `packages/afps-runtime/src/types/canonical-events.ts`   | `memory.added`, `state.set` event types   |
| `packages/afps-runtime/src/bundle/platform-prompt.ts`   | Renders "## Previous State" / "## Memory" |
| `packages/afps-runtime/src/runner/reducer.ts`           | Folds both into `RunResult`               |
| `scripts/system-packages/tool-set-state-1.0.0/`         | AFPS package for `set_state` tool         |
| `scripts/system-packages/tool-add-memory-1.0.0/`        | AFPS package for `add_memory` tool        |
| `runtime-pi/*`                                          | Pi container orchestration + logs         |

Frontend:

| File                                 | What it does           |
| ------------------------------------ | ---------------------- |
| `apps/web/src/pages/run-detail.tsx`  | Renders run state      |
| `apps/web/src/locales/*/agents.json` | French/English strings |

## Scope of THIS PR

Delivered in this PR:

- [x] Phase 0 — Audit + design doc
- [x] Phase 1 — DB schema + data migration (additive; legacy stores kept)
- [x] Phase 2 — Backend service layer (unified reads/writes)
- [x] Phase 3 — API routes (unified `/persistence` endpoint + `/memories` back-compat shim)
- [x] Phase 4 — Rename `set_state` → `set_checkpoint` in AFPS runtime + conformance + runtime-pi + system-package tools. Canonical-event contract bump
      (`state.set` → `checkpoint.set`) shipped with dual-event acceptance for
      back-compat — runners speaking the legacy event still finalize correctly.
- [x] Phase 5 — `run_history` field rename (`state` → `checkpoint`) with actor-scoped
      isolation in the sidecar lookup.
- [x] Phase 6 — Frontend UI rename ("State" → "Checkpoint", `exec.tabState` →
      `exec.tabCheckpoint`, hash anchor `#state` → `#checkpoint`) plus a scope
      filter (`All` / `Shared` / `Mine`) in the memory management tab. The web
      app now reads from the unified `/persistence` endpoint and tags each row
      with its actor scope.
- [x] Phase 7 — Docs
- [x] Phase 8 — Final cut: drop `package_memories` table, rename
      `runs.state` → `runs.checkpoint`, drop `set_state` tool +
      `state.set` event, drop `memories:*` RBAC + `/memories` routes.
      No production data existed during the transition, so the
      planned double-write window was collapsed into a single PR.

## Single-store strategy

Finalize writes to `package_persistence` only — the unified store is the
sole system of record for both checkpoints and memories. `runs.checkpoint`
remains as a per-run snapshot of what the runner emitted (read by
`getRecentRuns` to feed the sidecar `run_history` tool); the unified store
keeps only the latest checkpoint per actor.

## Open questions

- **Where should the checkpoint fallback chain stop?** Current plan: try
  actor-specific row, fall back to `shared`. But a cron-scheduled run's
  actor is `shared` by construction — should it also read per-user
  checkpoints when it then calls an end-user-scoped sub-operation? For now,
  no: `shared` reads see `shared` only.
- **Memory scope default for pre-1.3 agents.** Existing `add_memory` calls
  (no `scope` parameter) default to `actor`. This is a behaviour change
  for any agent that today relies on one user's discovery leaking into
  another user's next run. In practice the pre-`applicationId` migration
  already broke cross-org leaks; the cross-actor leak was only a thing for
  single-tenant OSS.
- **TypeScript `Actor.type` vocabulary mismatch.** `@appstrate/connect`
  uses `"member"` for dashboard users; the DB column uses `"user"` for
  brevity and because the `@afps-spec/schema` wire format also says `user`.
  We translate at the storage boundary — the service layer speaks `Actor`,
  the DB speaks `actor_type`.
