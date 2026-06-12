---
description: Exhaustive REST payload audit — dispatches an agent that authors and runs an Opus multi-agent workflow to find every mutating endpoint that doesn't return its full resource, plus every legacy/backward-compat shim that must be removed
---

# /audit-rest-payloads — REST mutation-response audit

100%-coverage audit of the API's mutating endpoints against one rule: **every mutation returns the full resource payload, with zero legacy/backward-compat cruft.** It delegates to a single orchestrator agent whose job is to author and run an **Opus multi-agent `Workflow`** that parses the entire codebase exhaustively — no router, module, or path skipped — then synthesizes a tracked report.

## When to use

- After a convention sweep (e.g. #646) to confirm nothing was missed and to find the next batch
- Before a release, to prove the mutation surface is uniform
- Whenever a new router/module is added and you want to check it conforms
- Periodic health-check on REST consistency

## The convention (authoritative — stricter than #646)

There is **no production data**, so backward compatibility is **not a constraint**. The rule is absolute:

1. **Create (`POST`)** → `201` + the created resource, serialized by the **same serializer as its `GET` detail** (`$ref` the resource component schema directly — NOT `allOf: [Resource, {…}]`).
2. **Update (`PUT`/`PATCH`)** → `200` + the updated resource, same serializer as `GET` detail.
3. **Delete (`DELETE`)** → `204` empty.
4. **No legacy aliases, no compat envelopes.** The resource is returned **bare**. Specifically, these must be **removed** wherever they exist:
   - duplicated id aliases next to the canonical `id` (`runId`, `packageId`, `proxyId`, `modelId`, …)
   - `{ success: true }` / `{ ok: true }` booleans
   - operation-status scraps stapled onto a resource (`active`, `activated_at`, `lock_version`, `message`, `warnings`, `restored_version`, `deleted`, `updated`, …) **unless** they carry information that is genuinely NOT part of the resource AND a consumer needs it — in which case they belong in a documented, named envelope, not sprinkled at the top level. Default verdict: **remove**.
   - any `allOf: [ { $ref: Resource }, { …compat } ]` response schema introduced for backward compatibility — collapse to the bare `$ref`.
5. **Legitimate action endpoints** keep their operation-result shape and are NOT targets (flag them so they're not false-positives):
   - one-time secret reveal (`POST /api-keys` raw key, webhook `rotate`)
   - flow initiation (`connect/oauth2` → `auth_url`/`state`)
   - presign envelope (`POST /uploads`)
   - multi-entity operation report (`packages/import*` → per-item results)
   - synthetic test (`webhooks/:id/test`, `*/test` connection checks, `runs/inline/validate` dry-run)
   - transport passthroughs (`credential-proxy`/`llm-proxy`/`mcp` JSON-RPC, run-event HMAC ingestion ACKs) and browser auth flows (OIDC login/register/consent/activate, invite accept)
   - **bulk mutations** (`DELETE /runs`, `DELETE …/persistence`, `PUT /notifications/read-all`) — a mass delete/update is an action over a set, not a single resource. These keep a **documented operation result** (`{ deleted_count }` / `{ updated_count }`), NOT a 204 and NOT a resource. (Decision: 2026-06.)
     These return an operation result, not a single resource — that's correct.

> Note: PRs #645–#651 deliberately KEPT compat fields (`runId`, `success`, `lock_version`, `active`, `packageId`, …) because the convention issue #646 assumed backward-compat mattered. Under THIS stricter rule they are now **cleanup targets** — the audit must surface every one of them for removal.

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
- Report the existing compat shims from #645–#651 (`runId`, `success`, `lock_version`, `active`, `packageId`, version aliases, …) as removal targets — NOT conformant under the no-backward-compat rule.

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
> ## Compat shims to remove (from #645–#651)
> - … (field-level: where each legacy alias / allOf lives)
>
> ## Summary
> - Conformant: X | Stub: Y | Partial: Z | Compat-shim: W | Legit-action: A
> - Total cleanup endpoints: Y+Z+W
> - Suggested fix batching: one PR per family, smallest blast radius first
> ```

## After the audit completes

1. Relay the consolidated report.
2. If defects exist, propose the fix plan: **one PR per family**, each PR (a) aligns stubs/partials to return the bare resource and (b) **strips** the compat shims. Because there's no prod data, fixes are NOT additive — old fields are deleted, OpenAPI `allOf` collapses to a bare `$ref`, and consumers (`apps/web`, CLI) are updated to read the resource (`id` not `runId`, the object not `{success}`).
3. Each fix agent: branch from `origin/main`, worktree, `bun run check` (verify-openapi + `detect:breaking` — note breaking changes ARE expected here since we remove fields; that's acceptable with no prod data, but call them out explicitly in the PR), tests updated to the new shape, PR `Refs #646` (or a fresh tracking issue), worktree cleaned up.
4. Ask the user before dispatching fix agents — don't auto-fix.

## Notes for the executing assistant

- **The main thread owns the orchestration.** `Workflow` and `Agent` exist only on the main thread — a spawned sub-agent cannot fan out further. Do NOT delegate the whole audit to one agent expecting it to run a Workflow; it will fail and fall back to a slow inline scan. Call `Workflow` yourself, or dispatch the Phase-1/2 Opus agents yourself in parallel.
- Opus on every audit agent — the classification is judgment-heavy (handler-vs-spec reconciliation, action-vs-defect calls).
- Read-only audit. No file is modified during the audit phase.
- This command supersedes the additive posture of #646: the goal is now **bare resources everywhere, no legacy**.
