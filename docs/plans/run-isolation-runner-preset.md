# Run isolation between members + `runner` preset

Status: proposed, 2026-09-09. Two deliverables, two PRs, in this order.
Per-package visibility (`packages.visibility` / `owner_user_id`) is deliberately
out of scope — it is the next plan and builds on the predicates introduced here.

Context: a customer runs a shared agent with colleagues. Today every member
holding `runs:read` reads every run in the space (prompts, logs, outputs), and
the lowest preset that can launch an agent (`operator`) also reads the agent's
full manifest and prompt plus every skill. She wants a colleague who can _run_
and see _their own_ runs, and nothing else.

Both parts sit on the two-layer RBAC shipped by PR #1260 (migration 0056).
That lot is merged but not deployed; production has none of it. Deploying
0056→0058 is the precondition, not a step of this plan.

---

## Part A — `runs:read-all`: own runs by default (need #4)

### A.1 Decisions

- **D-A1 — a permission, not a space setting.** `runs:read` becomes "runs I
  own" — strictly `actorFilter` (`user_id = me`, or `end_user_id = me` for an
  end-user principal). A new `runs:read-all` restores today's space-wide read:
  other members' runs, end-users' runs, and any legacy row with no actor.
  Rationale: the model already says visibility is `effective(space)` computed
  per request; a setting would be a second policy source, need a settings UI,
  and would not compose with custom roles. A custom role can re-add `read-all`
  to whoever needs it.
- **D-A1b — no "actor-less runs are visible to everyone" branch.** Every live
  launch path carries an actor: the scheduler throws `internalError()` on a
  schedule without one (`services/scheduler.ts:128-135`, CHECK
  `package_schedules_exactly_one_actor`), and `run-pipeline.ts:460-463` states
  "other run paths always have an actor". Rows with both `user_id` and
  `end_user_id` NULL are pre-#735 leftovers, reachable through `read-all` only.
  The `isNull(userId)` arm of `actorScopeFilter` is therefore **not** used for
  runs: for a `user` actor it also matches every end-user's run
  (`user_id NULL`, `end_user_id` set), which is exactly the supervision case
  `read-all` exists for. `actorScopeFilter` keeps its current callers
  (notifications, files arm for end-users); the run predicate is `actorFilter`.
- **D-A2 — presets.** `admin` and `builder` hold `read-all` (both derive from
  `SPACE_LEVEL_PERMISSIONS`, so this is automatic); `operator` and `viewer` do
  not. This is a **behaviour change** for existing operators and is announced
  as such in the CHANGELOG (`### Changed`).
- **D-A3 — `read-all` is API-key-grantable, not end-user-grantable.** An
  end-user principal is always strictly own-only (`actorScopeFilter` already
  collapses to ownership for `end_user`); nothing changes for them.
- **D-A4 — hidden means 404, not 403.** A run the caller may not read returns
  `run_not_found`, the same posture end-users get today (`routes/runs.ts:490`).
  A 403 would confirm the run exists.
- **D-A5 — one predicate, one helper.** No route re-derives the SQL. A single
  `runVisibilityFilter(c)` returns `undefined` when the caller holds
  `runs:read-all`, else `actorFilter(actor, { runs.userId, runs.endUserId })`
  (`apps/api/src/lib/actor.ts` — strict ownership; never `actorScopeFilter`
  here, see D-A1b, and never an inlined `or(...)`).
- **D-A6 — `?user=me` means strictly mine, for everyone.** Today it routes to
  `listUserRuns`, which uses `actorScopeFilter` and therefore includes
  end-user runs for a member. It switches to `actorFilter` so "me" is the same
  set whether or not the caller holds `read-all`. Small behaviour change,
  listed in the CHANGELOG.

Verified facts the design leans on:

- `runs.user_id` is the launching principal for dashboard sessions **and API
  keys** (`getActor` → `c.get("user")` is the key owner; `actorInsert`).
  Scheduled runs carry the schedule's frozen actor (`scheduler.ts:128-131`),
  so a member's own schedule stays visible to that member under plain
  `runs:read`; a colleague's schedule does not.
- Published files copy the run's attribution (`runs-events.ts:452-458`,
  `getRunAttribution`), so `files.user_id` mirrors `runs.user_id` and the file
  gallery can use the same helper on its own columns.
- The `run_update` NOTIFY payload already carries `user_id` and `end_user_id`
  (`packages/db/src/notify.ts:78-79`). The `run_log_insert` payload does not,
  but the trigger functions are `CREATE OR REPLACE`d at boot
  (`lib/boot.ts:248` → `createNotifyTriggers`) — extending the payload is a
  code change, **not a migration**.

### A.2 Vocabulary

| File                                                                                            | Change                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/permissions.ts:80`                                                           | `runs: "read" \| "read-all" \| "cancel" \| "delete"` + doc comment: `read` = runs the principal launched; `read-all` = every run in the space (other members, end-users, legacy actor-less rows). |
| `apps/api/src/lib/permissions.ts` presets                                                       | No edit needed for `admin`/`builder` (derived). Assert in the unit test that `operator`/`viewer` do **not** hold it.                                                                              |
| `apps/api/src/lib/permissions.ts:208` `API_KEY_ALLOWED_SCOPES`                                  | add `"runs:read-all"`.                                                                                                                                                                            |
| OIDC end-user scopes (`modules/oidc/auth/scopes.ts`)                                            | unchanged — not grantable.                                                                                                                                                                        |
| `docs/architecture/RBAC_PERMISSIONS_SPEC.md` §3.3 table (`operator` row), §3.4 `runs` row, §7.1 | document the split.                                                                                                                                                                               |

### A.3 Helper

`apps/api/src/lib/run-visibility.ts` (new, ~30 lines):

```ts
/** WHERE fragment narrowing runs to what the caller may read; undefined = no narrowing. */
export function runVisibilityFilter(c: Context<AppEnv>): SQL | undefined {
  if (c.get("permissions")?.has("runs:read-all")) return undefined;
  return actorFilter(getActor(c), { userId: runs.userId, endUserId: runs.endUserId });
}
```

Plus the same shape for the SSE path, which has no Hono context:
`runVisibilityForSubscriber({ permissions, userId, endUserId })` → `{ readAll: boolean }`.

### A.4 Read surfaces (each one gets the predicate)

| Surface                                                    | File                                                                                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/runs`                                            | `routes/runs.ts:423`, `services/state/runs.ts:1576` `listGlobalRuns`                                 | new option `visibility?: SQL`; push into `conditions`. The `?user=me` branch stays (documented closed set) but `listUserRuns` (`state/notifications.ts:331`) switches from `actorScopeFilter` to `actorFilter` (D-A6) — for a non-`read-all` caller both branches now return the same set.                                                                                                                                                                |
| `GET /api/agents/:scope/:name/runs`                        | `routes/runs.ts:395`, `listPackageRuns` (`:1522`)                                                    | same option.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/runs/:id` (+ `?wait`)                            | `routes/runs.ts:479`, `getRunFull` (`:1681`)                                                         | add `visibility` to `conditions`; a miss is `notFound`. The `?wait` re-check goes through the same call, so it inherits the predicate.                                                                                                                                                                                                                                                                                                                    |
| `GET /api/runs/:id/logs`                                   | `routes/runs.ts:549`, `getRun` (`:1357`)                                                             | `getRun` already projects `userId`/`endUserId`: keep the query, add an in-handler ownership check via a shared `assertRunVisible(c, row)` that throws `notFound`. Same helper reused below.                                                                                                                                                                                                                                                               |
| `POST /api/runs/:id/cancel`, `DELETE /api/runs/:id`        | `routes/runs.ts:606`, `:837`                                                                         | `assertRunVisible` after the row load. `cancel`/`delete` permissions stay as they are — they gate the _action_, visibility gates _which rows_.                                                                                                                                                                                                                                                                                                            |
| Run workspace/files routes that load a run by id           | `routes/runs.ts` (`/runs/:id/workspace`, `/runs/:id/files*` if any under `runs:read`)                | `assertRunVisible`. Grep `getRun(scope, runId)` / `getRunFull(` in `routes/` and cover every hit.                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/agents` running counts                           | `getRunningRunCounts` (`state/runs.ts:1337`)                                                         | add optional `visibility` → `extra`. Otherwise the count leaks "someone else is running this".                                                                                                                                                                                                                                                                                                                                                            |
| Agent detail `last_run`                                    | `agent-detail-handler.ts` → `getLastRun(scope, agent.id, null)`                                      | pass the predicate; `last_run` must be the caller's last run.                                                                                                                                                                                                                                                                                                                                                                                             |
| Files gallery                                              | `services/files.ts:1439-1452` arm 1 (`isNotNull(files.runId)` = "org-wide, mirroring the runs list") | arm 1 becomes `and(isNotNull(files.runId), actorFilter(actor, { files.userId, files.endUserId }))` when the caller lacks `read-all`; unchanged otherwise. Arm 2 (own rows) already covers it for most cases, arm 3 (detached `agent_output`, org-readable) is left as is — a detached output has lost its run container, and hiding it would need `read-all` semantics on a row that no longer knows its run. `listFiles` already receives `permissions`. |
| Notifications, `run_history` runtime tool, `getRecentRuns` | —                                                                                                    | already actor-scoped; no change. Assert in tests only.                                                                                                                                                                                                                                                                                                                                                                                                    |
| MCP `run_and_wait`, `invoke_operation`                     | —                                                                                                    | dispatch through the same routes with the caller's permissions; covered by construction.                                                                                                                                                                                                                                                                                                                                                                  |
| Role preview (`X-View-As`)                                 | —                                                                                                    | persona permissions flow through `c.get("permissions")`; covered.                                                                                                                                                                                                                                                                                                                                                                                         |

### A.5 Realtime (SSE)

`services/realtime.ts`, subscriber filter (`:31-54`): add `readAll: boolean`,
set from the validated auth in `routes/realtime.ts:561/587/609` (compute with
the same `permissions` set that already yields `canReadDebugLogs`).

| Channel                                                                    | Gate today                                             | Gate added                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_update` (`:116-125`)                                                  | end-user own-only                                      | `if (!sub.filter.readAll && sub.filter.userId !== undefined && raw.user_id !== sub.filter.userId) continue;` — strict; a `user_id NULL` frame (end-user or legacy run) reaches only `read-all` subscribers. The existing end-user gate stays as the `endUserId` arm.            |
| `run_log` (`:154-164`)                                                     | end-user skipped (payload has no actor)                | extend `notify_run_log_insert()` (`notify.ts:95-120`) to select `user_id, end_user_id` alongside `space_id` from `runs`, then apply the same gate. Boot re-`CREATE OR REPLACE`s the function; no migration. This also unblocks the documented "per-end-user log streaming" gap. |
| `run_metric` (`:196-205`)                                                  | end-user skipped                                       | same: check whether the metric payload carries the run's actor; if not, resolve it the same way as `run_log`.                                                                                                                                                                   |
| Per-run stream `GET /api/realtime/runs/:id` (`routes/realtime.ts:507-530`) | loads the run row (`userId`, `endUserId`) at subscribe | refuse the subscription with 404 when the row fails `assertRunVisible` — cheaper than filtering every frame.                                                                                                                                                                    |

`Last-Event-ID` replay stays unsupported (documented); nothing here changes it.

### A.6 SPA

Server-side filtering means the runs list and run detail need no code
change. Two touches:

- `apps/web/src/pages/runs*.tsx` — if a "mine / all" toggle exists (it maps to
  `?user=me`), show it only when `can("runs:read-all")`; otherwise the list is
  already "mine".
- Regenerate `apps/web/src/api/schema.d.ts` (`available-scopes` now lists
  `runs:read-all`).

### A.7 Tests

- `apps/api/test/unit/permissions.test.ts` — `builder` has `runs:read-all`,
  `operator`/`viewer` do not; `validateScopes(["runs:read-all"])` accepted for
  a key whose creator holds it, dropped otherwise.
- `apps/api/test/integration/routes/runs-read-isolation.test.ts` (new; pattern
  of `runs-schedules-read-permissions.test.ts`): two `operator` members A/B in
  one space, a schedule owned by A that has fired once, one end-user run, and
  one legacy row inserted with both actor columns NULL.
  - A lists: A's manual runs + A's scheduled run. Not B's, not the end-user's,
    not the legacy row.
  - B lists: B's runs only — A's schedule is invisible to B.
  - A `GET /runs/:idB` → 404; `/logs` → 404; `cancel` → 404; `DELETE` → 404.
    Same four for the end-user run and the legacy row.
  - space `admin` (holds `read-all`) sees all five.
  - `?user=me` as admin → admin's own runs only (D-A6: no end-user, no legacy).
  - API key minted by A with `runs:read` only → same as A; with `runs:read-all` → all.
  - `X-View-As: preset:operator` from an owner → the owner's own runs only.
  - end-user principal (`Appstrate-User`) → its own run only, unchanged.
  - `GET /api/files` for A does not list B's or the end-user's run outputs.
  - `GET /api/agents` `running_runs` counts only A's running runs.
- SSE (`apps/api/test/integration/routes/realtime*.test.ts`): org-wide stream
  as A receives no `run_update`/`run_log` for B's run; per-run stream on B's
  run → 404.
- `e2e/tests/spaces/delegated-members.ui.spec.ts` — extend: second member
  cannot open the first member's run from the runs page (label `e2e`).

### A.8 Docs / release

- CHANGELOG `[Unreleased]` → `### Changed`: "`runs:read` now means the runs
  you launched — including your own schedules — and nothing else;
  `runs:read-all` (admin, builder) restores the space-wide view, end-user and
  scheduled runs of colleagues included. Custom roles can grant it.
  `GET /api/runs?user=me` is now strictly your own runs for every caller."
- `bun run openapi:baseline` (new enum value in `available-scopes`; non-breaking
  under `detect:breaking`).
- Migration: **none**.

---

## Part B — `runner` preset: launch without reading (need #12)

### B.1 Decisions

- **D-B1 — a fifth preset, not a custom role.** Custom roles are EE-gated
  (`services/space-roles.ts:55`, `features.custom_roles`) and owner/admin-only.
  The customer self-hosts the OSS build; a preset is a code constant and ships
  everywhere.
- **D-B2 — `agents:run` implies a _summary_ read.** Rather than a new
  `agents:list` permission, the two agent read routes accept `agents:read | agents:run`
  and shape the DTO on which one is held. The summary is exactly what the run
  form needs and nothing an author would call the agent's content. A new
  permission would make every existing `operator` key re-mint to keep listing.
- **D-B3 — what a runner holds.** Space-level:
  `agents:run`, `runs:read`, `runs:cancel`, `files:read`, `persistence:read`,
  `integrations:read`, `integrations:connect`, `integrations:disconnect`,
  plus module contributions `chat:read`, `chat:write`, `mcp:read`, `mcp:invoke`.
  **Not**: `agents:read`, `skills:read`, `mcp-servers:read`, `schedules:read`,
  `end-users:*`, `runs:read-all`, any `:write`.
  Chat and MCP are included on purpose: they are the friendly surfaces a
  non-builder uses, and every write they can trigger (`import_package_file`,
  `run_and_wait`) is gated by the principal's own permissions — a runner cannot
  alter a package through them.
- **D-B4 — no `agents:read` ⇒ no manifest, no prompt, no dependencies.** The
  summary carries `id`, `display_name`, `description`, `scope`, `version`,
  `source`, `input` (schema + space values + locked fields — the run form needs
  it), `output` (shape only), `effective_timeout_seconds`, `running_runs`,
  `last_run` (own, per Part A). It omits `manifest`, `prompt`, `dependencies`,
  `lock_version`, `updatedAt`, `has_unarchived_changes`, `version_count`,
  `forked_from`. All of those are already optional on the wire (system agents
  omit them today, `agent-detail-handler.ts:178-185`), so the OpenAPI schema
  does not change shape — only its description.
- **D-B5 — French label « Exécutant », key `runner`.**

### B.2 Vocabulary and DB

| File                                             | Change                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/permissions.ts:293`           | `SPACE_ROLE_PRESETS = ["admin", "builder", "operator", "runner", "viewer"]`. Everything typed on `SpaceRolePreset` (Zod enums, view-as personas, `byPreset` records) now fails to compile until updated — that is the checklist.                                                                                                                                                                       |
| `apps/api/src/lib/permissions.ts:139-185`        | `RUNNER_PRESET_PERMISSIONS` per D-B3; add to `SPACE_PRESET_PERMISSIONS`. Keep the doc comment in the same voice ("use what is built, see only yours").                                                                                                                                                                                                                                                 |
| `packages/module-chat/src/index.ts:193,199`      | add `"runner"` to both `presets` arrays.                                                                                                                                                                                                                                                                                                                                                               |
| `apps/api/src/modules/mcp/index.ts:183,191`      | add `"runner"` to both.                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api/src/modules/webhooks/index.ts:119`     | unchanged (admin/builder only).                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/db/drizzle/0059_runner_preset.sql`     | `ALTER TABLE spaces DROP CONSTRAINT spaces_default_role_valid; ADD CONSTRAINT … CHECK (default_role IN ('admin','builder','operator','runner','viewer'));` and the same for `space_members_preset_valid` (`0056_space_roles.sql:70,143`). Snapshot + `_journal.json` entry (`idx: 59`, `when` > 0058's — see the drizzle index-collision memo: build the snapshot by hand and diff it against 0058's). |
| `packages/db/src/schema/spaces.ts:52-55,127-130` | update both `check(...)` literals to match.                                                                                                                                                                                                                                                                                                                                                            |
| Zod / OpenAPI                                    | `z.enum(SPACE_ROLE_PRESETS)` and the OpenAPI enums derive from the constant (no literal `"builder"` in `apps/api/src/openapi/*.ts`); regenerate the baseline.                                                                                                                                                                                                                                          |
| `apps/api/src/lib/view-as.ts:80,98`              | derived from the constant — compiles as-is; add `preset:runner` to the persona test matrix.                                                                                                                                                                                                                                                                                                            |

### B.3 Summary read on the two agent routes

| Route                                                 | File                                            | Change                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/agents`                                     | `routes/agents.ts:185`                          | guard `requireAnyPermission(["agents:read", "agents:run"])`. When `!permissions.has("agents:read")`: drop `dependencies`, `keywords` stay. `running_runs` already goes through Part A's predicate. |
| `GET /api/agents/:scope/:name`                        | `routes/agents.ts:311` → `buildAgentDetailDto`  | same guard; extend the existing `agent.source !== "system" && rawItem` branch with `&& hasAgentsRead` so the summary omits the D-B4 fields; also strip `dependencies` in that case.                |
| `GET /api/agents/:scope/:name/settings`               | `routes/agents.ts:375`                          | same disjunction — the run modal reads the resolved model from it (`run-modal.tsx:114`, `useAgentModel`). Read-only, exposes `modelId`/`generationConfig`, no prompt.                              |
| Everything else under `/api/agents/*`                 | versions, bundle export, files explorer, drafts | unchanged: `agents:read` / `agents:write`. A runner gets 403 there, which is the point.                                                                                                            |
| `/api/packages/skills*`, `/api/packages/mcp-servers*` | —                                               | unchanged: `skills:read` / `mcp-servers:read`; 403 for a runner.                                                                                                                                   |
| `requireAgent` (`middleware/guards.ts:12`)            | —                                               | unchanged (space-access lookup, no read permission).                                                                                                                                               |

Also list `runner` in `docs/architecture/RBAC_PERMISSIONS_SPEC.md` §3.3 and add
a sentence to §3.4 `agents` row: "`run` also grants the summary projection of
the two agent read routes (no manifest, prompt or dependencies)".

### B.4 SPA

| Where                                                               | Change                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/locales/{fr,en}/settings.json`                        | `roles.preset.runner`: « Exécutant » / "Runner"; the preset selects (`use-roles.ts:169`, `org-settings/space/general.tsx:61`) derive from `SPACE_ROLE_PRESETS`.                                                                                     |
| Sidebar (`components/app-sidebar.tsx` — no permission gating today) | hide **Skills** without `skills:read`, **MCP servers** without `mcp-servers:read`, **Schedules** without `schedules:read`. Agents entry shown when `agents:read \|\| agents:run`.                                                                   |
| `pages/package-list.tsx` (agents)                                   | render when `can("agents:read") \|\| can("agents:run")`; card already tolerates missing `dependencies`? — verify, else guard the deps badge.                                                                                                        |
| `pages/unified-package-detail.tsx`                                  | tabs Editor / Files / Versions / Settings gated on `can("agents:read")` (currently only `agents:configure` at `:279` for install controls). Runner sees Overview + Runs + **Run** button (`run-agent-button.tsx:152` already keys on `agents:run`). |
| `components/run-modal.tsx`                                          | no change — consumes `agent.input` and the settings route, both in the summary.                                                                                                                                                                     |
| Runs page                                                           | Part A: already "mine".                                                                                                                                                                                                                             |
| Route guards in `app.tsx`                                           | agent editor routes (`/agents/:id/edit`…) redirect when `!can("agents:read")`.                                                                                                                                                                      |
| `hooks/use-permissions.ts`                                          | no change (`can` reads the server-computed set).                                                                                                                                                                                                    |

### B.5 Tests

- `apps/api/test/unit/permissions.test.ts` — exact `runner` set (assert the
  full list, positive and negative, so a future grant is a deliberate diff).
- `apps/api/test/unit/module-principal-permissions.test.ts` — chat/mcp
  contributions reach `runner`.
- `apps/api/test/integration/routes/runner-preset.test.ts` (new; pattern of
  `rbac-disjunction-and-space-package-reads.test.ts`): member with
  `preset_role: "runner"`:
  - `GET /api/agents` → 200, no `dependencies`;
  - `GET /api/agents/:s/:n` → 200 with `input`, without `manifest`/`prompt`/`dependencies`;
  - `GET /api/agents/:s/:n/settings` → 200;
  - `GET /api/agents/:s/:n/versions`, `/bundle`, `/files` → 403;
  - `GET /api/packages/skills` → 403; `PUT /api/agents/:s/:n` → 403;
  - `POST /api/agents/:s/:n/run` → 202; `GET /api/runs` lists only own (Part A);
  - `POST /api/packages/import` → 403 (the "cannot break my skills" guarantee);
  - `X-View-As: preset:runner` from an owner reproduces the same answers.
- `packages/db` migration test (if the suite has one for CHECKs): inserting
  `preset_role = 'runner'` succeeds; `'bogus'` fails.
- `e2e/tests/spaces/management.ui.spec.ts` — the default-role select offers
  « Exécutant »; `delegated-members.ui.spec.ts` — a runner lands on the agents
  page, sees Run, sees no editor tab, sees no Skills entry (label `e2e`).

### B.6 Docs / release

- CHANGELOG `[Unreleased]` → `### Added`: the preset, in the same voice as the
  RBAC entry above it.
- `docs/architecture/RBAC_PERMISSIONS_SPEC.md` §3.3 table, §3.4 note, §6.7
  (persona list mentions presets), §7.1 unchanged.
- Migration **0059** (two CHECK constraints). Auto-applied at boot; no operator
  step, no env var.

---

## Sequencing

1. **PR A** — `runs:read-all` + predicates + SSE + files arm + tests + CHANGELOG
   _Changed_. No migration. Behaviour change for operators: say so in the
   release note.
2. **PR B** — `runner` preset + migration 0059 + summary read + SPA gating +
   tests + CHANGELOG _Added_. Depends on A for "a runner sees only their runs".
3. Production deploys the whole RBAC lot at once: 0056 → 0059 in one boot
   (see the beta.54 memo — pre-flight on the replica, count pending migrations
   from the journal). Nothing new to configure.

Effort, relative: A is the smaller of the two in code but the wider in
surfaces to cover (every place a run row is loaded); B is mostly mechanical
once the constant changes, with the SPA gating as the only design work.

## Open items to verify while implementing

- `run_metric` NOTIFY payload: does it carry the run actor? If not, resolve it
  in the trigger like `run_log`.
- `package-list.tsx` card: tolerant of a missing `dependencies`?
- Any route outside `routes/runs.ts` that loads a run by id under `runs:read`
  (`runs-events.ts` is HMAC-signed sink traffic, not a principal read — out of
  scope). `grep -rn "getRun(\|getRunFull(" apps/api/src/routes apps/api/src/modules`.
- Chat: `run-reconcile.ts` and the chat UI's run cards read runs server-side
  with the session principal — confirm they go through the visibility helper
  or a server-trusted path, never a widened one.
- A team of operators who _want_ to see each other's runs cannot compose
  "operator + `runs:read-all`" on the OSS build: custom roles are EE-gated,
  so their only option is `builder`, which also grants `:write`. Either accept
  it (a team that needs that governance is an EE team) or lift custom roles
  out of the EE gate. Decided separately; not part of this plan.
