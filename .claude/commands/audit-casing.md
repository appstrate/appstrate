---
description: Exhaustive casing convention audit — dispatches parallel opus sub-agents to verify every layer respects docs/CASING_CONVENTIONS.md without deviation
---

# /audit-casing — Casing convention audit

This skill performs a 100%-coverage audit of casing conventions across the appstrate workspace. It dispatches multiple opus sub-agents in parallel, each scanning a specific dimension, and consolidates findings into a single report.

## When to use

- Before merging a large branch that touched DTOs, manifests, OpenAPI, or DB schemas
- After upgrading Better Auth, Drizzle, or any framework that might re-introduce casing drift
- As a periodic health-check (monthly or per release)
- Whenever you suspect a casing inconsistency

## What it checks

The audit references `docs/CASING_CONVENTIONS.md` as authoritative. It verifies:

1. **Zone 1 — Wire JSON snake_case**: API responses, OpenAPI components, AFPS manifests, request bodies, OAuth2 fields
2. **Zone 2 — Drizzle TS schema**: every `pgTable()` uses `camelCase: type("snake_alias")` pattern
3. **Zone 3 — TS internal**: function args, variables, props, state stay camelCase
4. **Zone 4 — Carve-outs preserved correctly**:
   - Better Auth tables (4a)
   - Universal DB convention fields (4b)
   - Profile/Member DTOs (4c)
   - Module hook contracts (4d)
   - ModelProviderDefinition (4e)
   - Connect-helper internal types (4f)
   - JSONB internal contracts (4g) — split: internal-only (producer casing) vs wire-exposed (snake_case, e.g. `org_settings`)
   - SSE camelCase (4h)
   - CloudEvents (4i)
   - Webhook deliveries (4j)
   - BullMQ job data (4k)
   - Logger fields (4l)
   - Audit log JSONB shapes (4m)
5. **Zone 5 — Documented asymmetries**: env-vars JSON split, SSE vs REST

## Behavior

When invoked, this skill:

1. Reads `/Users/pierrecabriere/Dev/appstrate/appstrate/docs/CASING_CONVENTIONS.md` to confirm the current authoritative rules
2. Verifies the working tree is clean and reports current HEAD
3. Dispatches **6 opus sub-agents in parallel**, each scanning a specific surface:
   - **Agent A — Schema layer**: AFPS Zod + JSON Schema + appstrate validation/integration/mcp-server. Confirms canonical snake_case is intact.
   - **Agent B — Wire DTO layer**: shared-types + OpenAPI components + path examples + route projection sites. Verifies every wire field matches the canonical catalog (snake_case domain, camelCase universal DB conv).
   - **Agent C — Drizzle TS schema**: every `pgTable()` in `packages/db/src/schema/*.ts` + module schemas. Confirms TS field property names are camelCase, SQL aliases are snake_case.
   - **Agent D — Frontend consumers**: `apps/web/src/` reads of wire DTOs. Confirms no camelCase reads on snake_case fields (would return undefined at runtime).
   - **Agent E — Carve-outs**: Better Auth tables, OIDC plugin tables, ModelProviderDefinition, profile reads, module hook contracts, CloudEvents, Webhooks, BullMQ, audit logs, SSE transform, JSONB internals.
   - **Agent F — Cross-repo + tests**: cloud, docs, website, module-claude-code, connect-helper, afps-spec + test fixtures + e2e helpers. Confirms no drift introduced by parallel work.

Each sub-agent produces a structured report classified by severity:

- 🔴 **BUG**: real deviation from convention (e.g. camelCase wire field, snake_case Drizzle TS field, BA carve-out violated)
- 🟡 **DRIFT**: documentation/comment stale but runtime correct
- ✅ **VERIFIED CLEAN**: surface confirmed conforming

4. Consolidates the 6 reports into a single summary:
   - Total bugs found across all dimensions
   - Per-zone verdict (✅ / 🟡 / 🔴)
   - Top issues to fix (sorted by severity)
   - Sample of "verified clean" surfaces for confidence

5. Reports the final verdict:
   - ✅ **100% compliant** — no action needed
   - 🟡 **Minor drift** — documentation cleanup recommended (low priority)
   - 🔴 **Bugs found** — list with file:line + suggested fix; ask user whether to dispatch fix agents

## Implementation notes (for the executing assistant)

When you (Claude) execute this skill:

1. Read `docs/CASING_CONVENTIONS.md` to get the latest authoritative rules
2. Run `git status` + `git log --oneline -5` to record starting state
3. Dispatch the 6 sub-agents IN PARALLEL via the Agent tool (all in one message with 6 tool_uses)
4. Each sub-agent should be opus model
5. Each sub-agent gets a focused prompt referencing this convention doc as authority
6. Wait for all 6 to complete
7. Consolidate findings into the unified report
8. Ask the user whether to fix any bugs found

### Sub-agent prompt template (per agent)

Each sub-agent should:

- Use `Read` to load `docs/CASING_CONVENTIONS.md` first
- Be told its specific zone responsibility
- Use `Grep` aggressively for exhaustive coverage
- Read suspicious files in full when ambiguous
- Distinguish bugs (deviation from convention) from intentional carve-outs (documented in the convention doc)
- Return a structured report:
  ```
  # Zone <X> — <name>
  ## Bugs: N
  - file:line — field — fix
  ## Drift (cosmetic): N
  - file:line — issue
  ## Verified clean: N items
  - sample list
  ## Verdict: ✅ / 🟡 / 🔴
  ```

### Coordination between agents

The sub-agents are **read-only**. They never modify files. After consolidation, the orchestrator (the executing Claude) decides whether to:

- Report findings and stop (default)
- Dispatch separate **fix agents** if the user opts in

### Exhaustivity guarantees

- **Every** TS/TSX file under `apps/`, `packages/`, `runtime-pi/`, `e2e/` is in scope
- **Every** JSON file matching `manifest.json` is verified
- **Every** Drizzle pgTable in `packages/db/src/schema/` is read
- **Every** OpenAPI component in `apps/api/src/openapi/` is verified
- **Every** module under `apps/api/src/modules/` is included
- Cross-repo: cloud, docs, website, module-claude-code, connect-helper, afps-spec (skip `_dev/`)

### Performance

Parallelized to ~3-5 min wall-clock total. Each opus agent: 5-15 min. Six agents in parallel = bounded by the slowest.

### Output format

```
# Casing Audit Report — <timestamp>

## Setup
- HEAD: <SHA>
- Working tree: clean / N modified
- Convention doc: docs/CASING_CONVENTIONS.md (last modified <date>)

## Per-zone results

### Zone 1 — Wire JSON
✅/🟡/🔴 — N hits, K bugs

### Zone 2 — Drizzle TS schema
...

### Zone 3 — TS internal
...

### Zone 4 — Carve-outs
- 4a Better Auth: ✅
- 4b Universal DB: ✅
- ...

### Zone 5 — Asymmetries (verify present)
- SSE camelCase transform: ✅ in place
- Env-vars split: ✅ as documented

## Cross-repo

| Repo | Bugs | Drift | Verdict |
|------|------|-------|---------|
| appstrate | 0 | 0 | ✅ |
| cloud | 0 | 0 | ✅ |
| ... | | | |

## Summary

- Total real bugs: N
- Total drift items: N
- Verified clean surfaces: N
- **Verdict: ✅ 100% compliant** / 🟡 Minor drift / 🔴 Bugs

## Top issues to fix (if any)

1. ...
2. ...

## Next steps

- ✅ → done, no action
- 🟡 → optional cleanup, propose batch fix?
- 🔴 → dispatch fix agents (Y/N)?
```

## Sub-agent dispatch prompts

Each agent receives a focused prompt. Below are the canonical prompts to dispatch (the orchestrator should fill in working directory and HEAD commit).

### Agent A — Schema layer

```
Mission: verify canonical AFPS schemas are 100% snake_case. Read `docs/CASING_CONVENTIONS.md` Zone 1 first.

Verify files:
- afps-spec/packages/schema/src/schemas.ts (Zod source)
- afps-spec/packages/schema/v2/*.schema.json (generated JSON Schema)
- appstrate/packages/core/src/validation.ts
- appstrate/packages/core/src/integration.ts
- appstrate/packages/core/src/mcp-server.ts
- appstrate/packages/core/src/form.ts
- appstrate/packages/core/schema/*.schema.json

For each Zod object, every field name MUST be snake_case (except the legacy lenient camelCase fallback in form.ts, which is documented and preserved).

Output: per-file verdict, bug list, verified clean count.
```

### Agent B — Wire DTO layer

```
Mission: DISCOVER every camelCase wire field that should be snake_case — do NOT just check known fields against a catalog. Read `docs/CASING_CONVENTIONS.md` Zone 1 + Carve-out 4b first.

⚠️ DISCOVERY MODE (not conformance): the catalog in the convention doc is necessarily incomplete and WILL miss long-standing leaks (this is exactly how oauthEmail/needsReconnection/candidateConnectionIds/ttlSeconds/finalizeUrl/createdBy escaped a prior audit). Do NOT treat "not in the catalog" as "fine". Enumerate the ACTUAL fields on the wire and flag any camelCase whose literal name is not on the EXACT universal carve-out list (matched by NAME, never by suffix similarity).

Scope:
- packages/shared-types/src/*.ts (every interface)
- apps/api/src/openapi/schemas.ts (every component property)
- apps/api/src/openapi/paths/*.ts (every request body, response schema, AND example — examples leak real field names)
- apps/api/src/openapi/baseline.json (verify regenerated, no stale fields)
- apps/api/src/routes/*.ts + apps/api/src/services/*.ts (serializer sites: every `c.json({...})`, every object spread onto a response, every `mapRow`/`toXWire` builder)

Method:
1. Extract the full set of property names emitted in OpenAPI response/request schemas AND in real `c.json(...)` projections.
2. For EACH camelCase name: is its literal name on the universal carve-out list (id, *Id, *At timestamps, runNumber, runOrigin, contextSnapshot, modelCredentialId)? Yes → OK. No → BUG (must be snake_case). Pay special attention to `*By` (createdBy → created_by), `*Name`, `*Email`, `*Url`, and boolean flags (needsReconnection, isNewUser, requiresLogin, dashboardSsoEnabled) — these are the common leaks.
3. Cross-check spec vs serializer: a field the code emits camelCase but the spec documents snake_case (or vice-versa) is BOTH a casing bug AND spec↔code drift — report it.

Output: per-interface/component table, the discovered field set (so coverage is auditable), total bugs, verdict.
```

### Agent C — Drizzle TS schema

```
Mission: verify every Drizzle pgTable uses camelCase TS / snake_case SQL pattern. Read `docs/CASING_CONVENTIONS.md` Zone 2 + Carve-out 4a first.

Scope:
- packages/db/src/schema/*.ts (every schema file)
- apps/api/src/modules/*/schema.ts (module-owned tables)
- cloud/src/schema.ts or drizzle/schema.ts

For each pgTable:
- Every TS field property name MUST be camelCase
- SQL aliases via text("snake_case") arg
- No snake_case TS field names (would break Better Auth + violate convention)

Output: per-file count, any TS field starting with [a-z]+_[a-z_]+: → BUG.
```

### Agent D — Frontend consumers

```
Mission: verify apps/web reads use the right casing per wire field. Read `docs/CASING_CONVENTIONS.md` full first.

⚠️ DO NOT rely on a hardcoded list of camelCase names — a fixed allowlist only catches fields someone already knew about and is precisely how prior leaks (oauthEmail, finalizeUrl, candidateConnectionIds, dashboardSsoEnabled) went undetected. Derive the suspect set from the SPEC, then trace consumers.

Method (two-way, spec-derived):
1. From Agent B's discovered wire field set (or by parsing apps/api/src/openapi/schemas.ts + paths/*.ts yourself), build the list of snake_case wire fields. For each, search apps/web/src/ for a camelCase read of the same concept (e.g. wire `oauth_email` → grep `oauthEmail`; `needs_reconnection` → `needsReconnection`). A camelCase read of a snake_case wire field → BUG (undefined at runtime).
2. Independently, grep apps/web/src/ for property reads off any `api()/apiList()/apiFetch()` response value and off shared-types DTO-typed variables; flag any camelCase access whose literal name is NOT on the universal carve-out list.

Classify each hit:
- Reading from a wire DTO / api() response → BUG if camelCase-not-carve-out (returns undefined at runtime)
- Reading from a Drizzle row passed through internally → OK (Drizzle TS stays camelCase)
- profile/Better Auth shape → OK (Carve-out 4a/4c); ModelProviderDefinition → OK (4e); SSE payload → OK (4h, camelCase by transform)
- Internal variable / function arg / React prop → OK (Zone 3)

Output: bug list with file:line and the actual variable type; report which snake_case wire fields were checked for a camelCase consumer (coverage).
```

### Agent E — Carve-outs

```
Mission: verify all 13 carve-outs (4a-4m) are correctly applied. Read `docs/CASING_CONVENTIONS.md` Zone 4 in full.

For each carve-out:
4a. Better Auth tables (auth.ts schema): all camelCase TS — verify
4b. Universal DB convention fields: stay camelCase EVERYWHERE (wire + Drizzle + frontend) — verify
4c. Profile/Member reads: camelCase displayName — verify no profile.display_name violations
4d. Module hook contracts (module.ts): camelCase interfaces — verify
4e. ModelProviderDefinition: camelCase — verify in core-providers, module-claude-code, module-codex
4f. Connect-helper internal types: camelCase — verify
4g. JSONB contracts — SPLIT by exposure (this carve-out ONLY covers JSONB that never crosses the wire verbatim):
    - Internal-only JSONB → producer-defined casing OK: token_usage interior snake_case, runs.metadata.creditsUsed camelCase — verify
    - Wire-exposed JSONB (returned/accepted RAW by a route, no per-key projection) → interior MUST be snake_case (Zone 1), NOT this carve-out. Verify organizations.org_settings interior is snake_case (api_version, dashboard_sso_enabled) since GET/PUT /api/orgs/:orgId/settings serialize it verbatim. To find others: for each jsonb() column, check whether any route returns it via `c.json` without rebuilding keys — if so it is wire and a camelCase interior key is a BUG (and renaming it later needs a JSONB data migration).
4h. SSE transform in realtime.ts:27 — verify snakeToCamel() still in place
4i. CloudEvents canonical-events.ts — verify camelCase
4j. Webhooks: verify camelCase end-to-end
4k. BullMQ ScheduleJobData, DeliveryJobData: verify camelCase
4l. Logger fields: spot-check pino calls
4m. Audit log: verify all recordAuditFromContext({ after }) uses camelCase explicit keys

Output: per-carve-out ✅/🔴 verdict + any violation found.
```

### Agent F — Cross-repo + tests

```
Mission: verify cross-repo coherence (skip _dev/) + test fixtures.

Repos: cloud, docs, website, module-claude-code, connect-helper, afps-spec

For each:
- Grep for any 1.x manifest residue (displayName, schemaVersion, fileConstraints, etc.)
- Classify: legit (internal TS, banner, migration table) vs bug

Test fixtures inside appstrate:
- e2e/helpers/seed.ts
- apps/api/test/**/seed*.ts and helpers
- system-packages/ manifest.json files
- local-test-packages/ manifest.json files

Verify all test fixtures use canonical snake_case AFPS 2.0 + camelCase universal DB conv where applicable.

Output: per-repo verdict + per-fixture-category status.
```

## Final assembly

After all 6 agents return:

1. Sum the total bugs across all reports
2. Build the per-zone table
3. List "verified clean" surfaces (high-level — not every file, but every category)
4. Compute global verdict:
   - 0 bugs + 0 drift → ✅ 100% compliant
   - 0 bugs + some drift → 🟡 minor drift, optional cleanup
   - 1+ bug → 🔴 must fix
5. Surface findings to user, ask for next step (fix all / fix subset / ignore)
