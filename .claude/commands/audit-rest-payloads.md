---
description: Exhaustive REST payload audit — dispatches an agent that authors and runs an Opus multi-agent workflow to find every mutating endpoint that doesn't return its full resource, plus every legacy/backward-compat shim to queue for deprecation
---

# /audit-rest-payloads — REST mutation-response audit

100%-coverage audit of the API's mutating endpoints against one target: **every mutation returns the full resource payload, with zero legacy/backward-compat cruft.** The audit is read-only and reports the gap — it never authorises deleting a field that ships in production (see the deprecation path below). It delegates to a single orchestrator agent whose job is to author and run an **Opus multi-agent `Workflow`** that parses the entire codebase exhaustively — no router, module, or path skipped — then synthesizes a tracked report.

## When to use

- After a convention sweep (e.g. #646) to confirm nothing was missed and to find the next batch
- Before a release, to prove the mutation surface is uniform
- Whenever a new router/module is added and you want to check it conforms
- Periodic health-check on REST consistency

## The convention (authoritative — the target shape)

> ⚠️ **Production exists and holds real data.** Backward compatibility **IS** a constraint. Removing or renaming a field that already ships on the wire is a **breaking change** for live consumers — the SPA, the CLI, API-key integrations, webhook receivers, published agents pinned to a version — and must be treated as one. This audit identifies the **target** shape and the gap to it. It does **not** authorise in-place deletions: schema changes go **forward and additive**, and every field removal needs the deprecation path described below.

The target shape:

1. **Create (`POST`)** → `201` + the created resource, serialized by the **same serializer as its `GET` detail** (`$ref` the resource component schema directly — NOT `allOf: [Resource, {…}]`).
2. **Update (`PUT`/`PATCH`)** → `200` + the updated resource, same serializer as `GET` detail.
3. **Delete (`DELETE`)** → `204` empty.
4. **No legacy aliases, no compat envelopes** — in the target shape. A **new** endpoint must ship bare from day one. On an **existing** endpoint the items below are **cleanup targets to report**, not fields to delete on sight:
   - duplicated id aliases next to the canonical `id` (`runId`, `packageId`, `proxyId`, `modelId`, …)
   - `{ success: true }` / `{ ok: true }` booleans
   - operation-status scraps stapled onto a resource (`active`, `activated_at`, `lock_version`, `message`, `warnings`, `restored_version`, `deleted`, `updated`, …) **unless** they carry information that is genuinely NOT part of the resource AND a consumer needs it — in which case they belong in a documented, named envelope, not sprinkled at the top level. Default verdict: **flag for deprecation**.
   - any `allOf: [ { $ref: Resource }, { …compat } ]` response schema introduced for backward compatibility — the target is the bare `$ref`.
5. **Legitimate action endpoints** keep their operation-result shape and are NOT targets (flag them so they're not false-positives):
   - one-time secret reveal (`POST /api-keys` raw key, webhook `rotate`)
   - flow initiation (`connect/oauth2` → `auth_url`/`state`)
   - presign envelope (`POST /uploads`)
   - multi-entity operation report (`packages/import*` → per-item results)
   - synthetic test (`webhooks/:id/test`, `*/test` connection checks, `runs/inline/validate` dry-run)
   - transport passthroughs (`credential-proxy`/`llm-proxy`/`mcp` JSON-RPC, run-event HMAC ingestion ACKs) and browser auth flows (OIDC login/register/consent/activate, invite accept)
   - **bulk mutations** (`DELETE /runs`, `DELETE …/persistence`, `PUT /notifications/read-all`) — a mass delete/update is an action over a set, not a single resource. These keep a **documented operation result** (`{ deleted_count }` / `{ updated_count }`), NOT a 204 and NOT a resource. (Decision: 2026-06.)
     These return an operation result, not a single resource — that's correct.

> Note: PRs #645–#651 deliberately KEPT compat fields (`runId`, `success`, `lock_version`, `active`, `packageId`, …) because the convention issue #646 assumed backward-compat mattered. **That assumption still holds** — production is live. They remain **cleanup targets**: the audit must surface every one of them so each gets a deprecation plan, not a deletion commit.

## Removing a field safely (the only sanctioned path)

Production is live, so a wire-level removal is a **breaking change** and follows the platform's date-based API versioning (`Appstrate-Version`, `middleware/api-version.ts`) rather than a straight delete:

1. **Add the canonical shape first** (additive, non-breaking): the resource is returned in full alongside whatever legacy field already exists.
2. **Migrate every in-repo consumer** (`apps/web`, `apps/cli`, e2e, tests, docs, system packages) to read the canonical field.
3. **Mark the legacy field deprecated** in OpenAPI (`deprecated: true` + a description naming its replacement and the removal version). Announce it in `CHANGELOG.md`.
4. **Only then** remove it, in a release explicitly documented as breaking — after checking who still depends on it (webhook receivers and API-key integrations are outside this repo and cannot be grepped).

`bun run detect:breaking` is the guard rail for steps 1–3: **a red `detect:breaking` is a stop sign, not a formality to acknowledge in the PR body.** It may only go red in a deliberate step-4 release.

## Behavior

When invoked, the executing assistant **drives the orchestration from the main thread** — sub-agents cannot call `Workflow` or `Agent` (those primitives exist only on the main thread), so do NOT delegate the orchestration to a single agent. The main thread either calls `Workflow` directly, or (if `Workflow` is unavailable) dispatches the Phase-1/Phase-2 agents itself in parallel via the `Agent` tool — exactly the pattern `/audit-casing` uses.

1. Records starting state: `git -C appstrate status` + `git log --oneline -5`. Note HEAD SHA. **Read the real HEAD — don't trust a cited SHA.**
2. Confirms the Workflow opt-in is satisfied — invoking this command IS the opt-in (these instructions tell you to call `Workflow`).
3. **List the route surface first** (don't hardcode): `ls apps/api/src/routes/*.ts` AND `find apps/api/src/modules -name 'routes.ts' -o -name 'router*.ts'` — the module convention is `routes.ts` (mcp/oidc/webhooks), not `router*.ts`. Then orchestrate the audit, owning the fan-out yourself:
   - **Preferred — `Workflow`**: author an Opus workflow (`model: 'opus'` on every agent) with the Phase 1/2/3 design below and run it.
   - **Fallback — parallel `Agent` dispatch** (when `Workflow` isn't in the toolset): split the route files across ~6 Opus agents, dispatched in ONE message, each returning structured rows; then you (main thread) synthesize Phase 3 and the completeness cross-check yourself.
4. Relays the consolidated report to the user and asks whether to dispatch fix agents (one PR per family, removing compat cruft + aligning stubs).

## Audit design — Phase 1/2/3 (drive from the main thread)

Use `model: 'opus'` on every audit agent. Handler reality (the actual `c.json(...)`, following one level into the service if delegated) wins over OpenAPI claims.

- **Phase 1 — Discover (fan-out, one agent per router/module slice).** Split all route files (`apps/api/src/routes/*.ts` + every `modules/**/routes.ts`) across N agents (≈4–6 files each). Each agent returns, for EVERY `POST`/`PUT`/`PATCH`/`DELETE`/`router.all` route in its files, a structured row: `{ file, verb, path, handlerReturn (verbatim-ish c.json shape, following one level into the service if delegated), openapiResponseSchema (from apps/api/src/openapi/paths/*), getDetailSerializerExists (name or null), hasLegacyCompat (which fields), category }`. Force structured output with a JSON schema so rows merge cleanly.
- **Phase 2 — Classify + adversarially verify.** For each row, an Opus agent confirms the classification by reading the actual handler + OpenAPI + the GET-detail serializer: `conformant` / `stub` (id/bool only) / `partial` / `has-compat-shim` (returns resource BUT with legacy aliases/allOf to strip) / `legit-action`. Catch Phase-1 mislabels (OpenAPI claims a resource while the handler returns a stub, or vice-versa). Output per endpoint: `{ ...row, finalCategory, fieldsToRemove[], serializerToReuse, fixEffort: trivial|moderate|tricky, notes }`.
- **Phase 3 — Synthesize (main thread or a final agent).** Dedup, group by family (proxies, models, agents, packages, runs, orgs, integrations, webhooks, oidc, …), produce the report below. Run a completeness critic: cross-check the discovered route count against a fresh `grep -rEc "\.(post|put|patch|delete|all)\(" apps/api/src/routes apps/api/src/modules` and reconcile the surplus (service-file `Map.delete`/array ops, `router.use`/`router.all`); list any route file no Phase-1 agent covered. Note that looped package-CRUD factories expand ×4 package types at runtime — count logical defects AND runtime instances.

Coverage guarantees:

- Every file in `apps/api/src/routes/` and every `modules/**/routes.ts` is assigned to exactly one Phase-1 agent (log the assignment; assert none dropped).
- Handler reality wins over OpenAPI claims.
- Distinguish the legitimate action exceptions (one-time secret, OAuth/flow init, presign envelope, multi-entity import report, synthetic test, transport passthroughs, browser auth flows) from real defects.
- Report the existing compat shims from #645–#651 (`runId`, `success`, `lock_version`, `active`, `packageId`, version aliases, …) as **deprecation targets** — they do not match the target shape, but they ship in production today and cannot simply be dropped.

Return this report (and nothing extraneous):

> ```
> # REST Payload Audit — HEAD <sha>
>
> ## Coverage
> - Route files scanned: N / N (list any uncovered)
> - Mutating endpoints found: M  (grep cross-check: M' — reconcile if ≠)
>
> ## Defects by family
> | endpoint | verb | current shape | defect | fix | serializer | effort |
> |---|---|---|---|---|---|---|
> … (one row per non-conformant endpoint)
>
> ## Legitimate action exceptions (not faults)
> - … (the ~5 + any others, with why)
>
> ## Compat shims to deprecate (from #645–#651)
> - … (field-level: where each legacy alias / allOf lives, + known consumers)
>
> ## Summary
> - Conformant: X | Stub: Y | Partial: Z | Compat-shim: W | Legit-action: A
> - Total cleanup endpoints: Y+Z+W
> - Suggested fix batching: one PR per family, smallest blast radius first
> ```

## After the audit completes

1. Relay the consolidated report.
2. If defects exist, propose the fix plan: **one PR per family**. Because production is live, each PR is **additive** — it (a) aligns stubs/partials so the endpoint also returns the full resource, (b) migrates in-repo consumers (`apps/web`, CLI, tests, e2e) to the canonical field (`id` not `runId`, the object not `{success}`), and (c) marks the legacy alias / `allOf` branch `deprecated: true` in OpenAPI. The actual field deletion is a **separate, later, explicitly-breaking release** — see "Removing a field safely" above. Never bundle a removal into the alignment PR.
3. Each fix agent: branch from `origin/main`, worktree, `bun run check` (verify-openapi + `detect:breaking` — this must stay **green**; a breaking diff means the PR crossed from "additive alignment" into "removal" and has to be split), tests updated to assert the new shape **without dropping assertions on the still-shipped legacy field**, PR `Refs #646` (or a fresh tracking issue), worktree cleaned up.
4. Ask the user before dispatching fix agents — don't auto-fix.

## Notes for the executing assistant

- **The main thread owns the orchestration.** `Workflow` and `Agent` exist only on the main thread — a spawned sub-agent cannot fan out further. Do NOT delegate the whole audit to one agent expecting it to run a Workflow; it will fail and fall back to a slow inline scan. Call `Workflow` yourself, or dispatch the Phase-1/2 Opus agents yourself in parallel.
- Opus on every audit agent — the classification is judgment-heavy (handler-vs-spec reconciliation, action-vs-defect calls).
- Read-only audit. No file is modified during the audit phase.
- **Production is live.** The target is bare resources everywhere, but reaching it is an additive, deprecation-gated migration — never a purge. An audit finding is a plan input, not permission to delete a field.
