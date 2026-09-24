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

1. **Zone 1 — Wire JSON snake_case**: API responses, OpenAPI components, AFPS manifests, request bodies, query strings, problem documents (`request_id`, `retry_after`), OAuth2 fields, wire-exposed JSONB interiors
2. **Zone 2 — Drizzle TS schema**: every `pgTable()` uses `camelCase: type("snake_alias")` and snake_case SQL identifiers
3. **Zone 3 — TS internal**: function args, variables, props, state stay camelCase; TS types mirroring a wire object keep the wire names
4. **Zone 4 — Carve-outs preserved correctly**:
   - Better Auth tables + plugin tables (4a)
   - Universal DB convention fields, `runId` included (4b)
   - Profile/Member DTOs (4c)
   - Module hook contracts (4d)
   - Model-provider names, name-based (4e)
   - Connect-helper internal types (4f)
   - JSONB contracts (4g) — split three ways: wire-exposed platform-written (snake_case), client/agent-supplied (opaque), internal-only (producer casing)
   - SSE camelCase (4h)
   - Run events / CloudEvents (4i)
   - Webhook deliveries (4j)
   - BullMQ job data (4k)
   - Logger fields (4l)
   - Audit log payloads, `AuditPayload` (4m)
   - Headless-platform DTO fields (4n)
   - Chat message metadata (4o)
   - Agent tool arguments (4p)
   - AFPS bundle container (4q)
   - `ExecutionContext` (4r)
   - Firecracker runner-daemon protocol (4s)
   - Sidecar / agent-container boot contracts (4t)
5. **Zone 5 — Documented asymmetries**: env-vars JSON split (5a), SSE vs REST (5b), model/proxy/credential ids, name-based (5c), Better Auth plugin management surfaces (5d)

## Automated gates (run these first)

Part of the audit is already automated. The orchestrator runs the gates before dispatching and hands their result to the agents:

```sh
bun test apps/api/test/unit/openapi-casing-carve-out.test.ts   # OpenAPI discovery gate
bun test packages/db/test/schema-casing.test.ts                # Drizzle, core schema
cd packages/module-ee && bun test test/unit/schema-casing.test.ts   # Drizzle, ee schema
```

- The OpenAPI gate walks the built spec (core + every module) and fails on any camelCase property name, query parameter name or example/default key that is not in its exported `CAMEL_CASE_CARVE_OUTS` (name → doc section), on an allowlist entry nothing uses, and on a snake_case twin of a 4b name outside `SNAKE_TWIN_EXCEPTIONS`. Path-template parameter names are not wire and are not checked.
- The allowlist and the doc must agree: every `CAMEL_CASE_CARVE_OUTS` entry must be listed in the doc section it names, and every camelCase wire name the doc lists must be in the allowlist. A mismatch either way is a 🟡 DRIFT finding (🔴 if the name has no carve-out at all).
- A red gate is a 🔴 finding by itself. A green gate proves only what the SPEC says: the agents still look for what it cannot see — serializers that disagree with the spec, TS readers using the wrong name, SSE frames, JSONB interiors, tool schemas, sibling repos.

## Behavior

When invoked, this skill:

1. Reads `docs/CASING_CONVENTIONS.md` (repo-relative) to confirm the current authoritative rules
2. Verifies the working tree is clean and reports current HEAD
3. Runs the automated gates above and records their result
4. Dispatches **6 opus sub-agents in parallel**, each scanning a specific surface:
   - **Agent A — Schema layer**: AFPS Zod + JSON Schema + appstrate validation/integration/mcp-server. Confirms canonical snake_case is intact.
   - **Agent B — Wire DTO layer**: shared-types + OpenAPI components + path examples + route projection sites. Discovery mode: finds every camelCase wire name and checks it against the doc's carve-out lists and the gate allowlist.
   - **Agent C — Drizzle TS schema**: every `pgTable()` in `packages/db/src/schema/*.ts` and `packages/module-ee/drizzle/schema.ts`. Confirms the schema casing tests cover what the doc says.
   - **Agent D — Consumers**: `apps/web/src/`, `packages/ui/src/`, `packages/module-chat/src/`, `apps/cli/src/` reads of wire DTOs. Confirms no camelCase reads on snake_case fields (undefined at runtime) and vice-versa.
   - **Agent E — Carve-outs**: every carve-out 4a–4t and asymmetry 5a–5d.
   - **Agent F — Cross-repo + tests**: sibling repos (on `origin/main`) + test fixtures + e2e helpers.

Each sub-agent produces a structured report classified by severity:

- 🔴 **BUG**: real deviation from convention (e.g. camelCase wire field, snake_case Drizzle TS field, BA carve-out violated)
- 🟡 **DRIFT**: documentation/comment stale but runtime correct
- ✅ **VERIFIED CLEAN**: surface confirmed conforming

5. Consolidates the 6 reports into a single summary:
   - Total bugs found across all dimensions
   - Per-zone verdict (✅ / 🟡 / 🔴)
   - Top issues to fix (sorted by severity)
   - Sample of "verified clean" surfaces for confidence

6. Reports the final verdict:
   - ✅ **100% compliant** — no action needed
   - 🟡 **Minor drift** — documentation cleanup recommended (low priority)
   - 🔴 **Bugs found** — list with file + symbol + suggested fix; ask user whether to dispatch fix agents

## Implementation notes (for the executing assistant)

When you (Claude) execute this skill:

1. Read `docs/CASING_CONVENTIONS.md` to get the latest authoritative rules
2. Run `git status` + `git log --oneline -5` to record starting state
3. Run the automated gates and keep their output for the report
4. Dispatch the 6 sub-agents IN PARALLEL via the Agent tool (all in one message with 6 tool_uses)
5. Each sub-agent should be opus model
6. Each sub-agent gets a focused prompt referencing this convention doc as authority, plus the gate results
7. Wait for all 6 to complete
8. Consolidate findings into the unified report
9. Ask the user whether to fix any bugs found

### Sub-agent prompt template (per agent)

Each sub-agent should:

- Use `Read` to load `docs/CASING_CONVENTIONS.md` first
- Be told its specific zone responsibility
- Use `Grep` aggressively for exhaustive coverage (exclude `node_modules` and `.claude/worktrees`)
- Read suspicious files in full when ambiguous
- Distinguish bugs (deviation from convention) from intentional carve-outs (documented in the convention doc)
- Cite a file and a symbol for each finding (line numbers rot)
- Return a structured report:
  ```
  # Zone <X> — <name>
  ## Bugs: N
  - file — symbol — field — fix
  ## Drift (cosmetic): N
  - file — issue
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
- **Every** Drizzle pgTable in `packages/db/src/schema/` and `packages/module-ee/drizzle/schema.ts` is read
- **Every** OpenAPI component and path in `apps/api/src/openapi/`, `apps/api/src/modules/*/openapi*` and `packages/module-*/src/openapi.ts` is verified
- **Every** module under `apps/api/src/modules/` and `packages/module-*` is included
- Cross-repo: docs, website, connect-helper, afps-spec, github-action — each on `origin/main`

### Performance

Parallelized to ~3-5 min wall-clock total. Each opus agent: 5-15 min. Six agents in parallel = bounded by the slowest.

### Output format

```
# Casing Audit Report — <timestamp>

## Setup
- HEAD: <SHA>
- Working tree: clean / N modified
- Convention doc: docs/CASING_CONVENTIONS.md (last modified <date>)
- Automated gates: OpenAPI ✅/🔴, Drizzle core ✅/🔴, Drizzle ee ✅/🔴

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
- 5c / 5d surfaces: ✅ as documented

## Cross-repo

| Repo | Ref | Bugs | Drift | Verdict |
|------|-----|------|-------|---------|
| appstrate | HEAD | 0 | 0 | ✅ |
| connect-helper | origin/main <sha> | 0 | 0 | ✅ |
| ... | | | | |

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

Each agent receives a focused prompt. Below are the canonical prompts to dispatch (the orchestrator should fill in working directory, HEAD commit and the gate results).

### Agent A — Schema layer

```
Mission: verify canonical AFPS schemas are 100% snake_case. Read `docs/CASING_CONVENTIONS.md` Zone 1 + the manifest catalog first.

Verify files:
- afps-spec/packages/schema/src/schemas.ts (Zod source — read origin/main of the afps-spec repo)
- afps-spec/packages/schema/v0/*.schema.json (generated JSON Schema)
- appstrate/packages/core/src/validation.ts
- appstrate/packages/core/src/integration.ts (incl. `findNonSnakeCaseIdentityClaimKeys` on identity_claims keys and identity_outputs — a WRITE-path policy wired through `CONFIG_BY_TYPE.integration.checkManifest` in apps/api/src/services/package-items/config.ts, deliberately NOT in `integrationManifestSchema`)
- appstrate/packages/core/src/mcp-server.ts
- appstrate/packages/core/src/form.ts (reads snake_case wrappers only; RJSF vendor keys are the documented exception)
- appstrate/packages/core/schema/*.schema.json
- system-packages/*.afps manifests: every identity_claims key snake_case

For each Zod object, every field name MUST be snake_case. Cross-check the doc's manifest catalog against the Zod source in both directions (a field in one and not the other is DRIFT).

Output: per-file verdict, bug list, verified clean count.
```

### Agent B — Wire DTO layer

```
Mission: DISCOVER every camelCase wire field that should be snake_case — do NOT just check known fields against a catalog. Read `docs/CASING_CONVENTIONS.md` Zone 1, Zone 4, Zone 5 and the Enforcement section first.

⚠️ DISCOVERY MODE (not conformance): the OpenAPI gate (apps/api/test/unit/openapi-casing-carve-out.test.ts) already discovers every camelCase name the SPEC declares. Your job is what it cannot see:
- serializers that emit a name the spec does not declare, or spell it differently (spec↔code drift)
- request bodies whose Zod schema and OpenAPI schema disagree
- JSONB returned verbatim (4g boundary rule): every jsonb() column a route returns without rebuilding keys — its platform-written interior keys must be snake_case
- the gate's `CAMEL_CASE_CARVE_OUTS` vs the doc: every entry listed in the section it names, every documented camelCase wire name in the allowlist

Scope:
- packages/shared-types/src/*.ts (every interface)
- apps/api/src/openapi/schemas.ts + paths/*.ts, apps/api/src/modules/*/openapi*, packages/module-*/src/openapi.ts (schemas AND examples)
- apps/api/src/openapi/baseline.json (verify regenerated, no stale fields)
- apps/api/src/routes/*.ts, apps/api/src/modules/*/routes.ts, apps/api/src/services/**/*.ts, packages/module-*/src (serializer sites: every `c.json({...})`, every object spread onto a response, every `toXWire` / `mapRow` builder, every `readJsonBody`/`parseBody` Zod schema)
- packages/core/src/api-errors.ts (problem documents: `request_id`, `retry_after`, `errors[]`)

Method:
1. Extract the full set of property names emitted in real `c.json(...)` projections and accepted by request Zod schemas.
2. For EACH camelCase name: is its literal name on a carve-out list of the doc (4b universal list incl. `runId`; 4c; 4e names; 4n; 5c everywhere it holds that id; 5d only on its own surface)? Yes → OK. No → BUG. Match by NAME, never by suffix similarity. Pay special attention to `*By`, `*Name`, `*Email`, `*Url`, `*Id` not on the 4b list, and boolean flags.
3. For each snake_case twin of a 4b name (`run_id`, `space_id`, `created_at`, …): BUG unless it is one of the doc's enumerated counter-exceptions.
4. Model-provider objects: one object = one casing family; only 4e names, 4b names and the 5c ids stay camelCase.

Output: per-interface/component table, the discovered field set (so coverage is auditable), total bugs, verdict.
```

### Agent C — Drizzle TS schema

```
Mission: verify every Drizzle pgTable uses camelCase TS / snake_case SQL. Read `docs/CASING_CONVENTIONS.md` Zone 2 + Carve-out 4a first.

The schema casing tests (packages/db/test/schema-casing.test.ts, packages/module-ee/test/unit/schema-casing.test.ts) check TS column keys and every SQL identifier the schema names. Confirm:
- both tests import the whole schema barrel they claim to cover (a table outside the barrel escapes the test)
- the Better Auth / plugin tables of 4a are exactly the ones in packages/db/src/schema/{auth,oidc}.ts, and the doc's table list matches
- no hand-written SQL in a drizzle migration introduces a non-snake identifier the TS schema does not declare

Scope:
- packages/db/src/schema/*.ts (the whole platform schema; built-in modules own no tables)
- packages/module-ee/drizzle/schema.ts (the one module with a schema of its own)

Output: per-file count, any TS field matching `[a-z]+_[a-z_]+:` → BUG.
```

### Agent D — Consumers

```
Mission: verify every TS consumer of the wire reads the right casing. Read `docs/CASING_CONVENTIONS.md` in full first.

Scope: apps/web/src, packages/ui/src, packages/module-chat/src (incl. src/ui), apps/cli/src, connect-helper (sibling repo, origin/main).

⚠️ DO NOT rely on a hardcoded list of camelCase names — derive the suspect set from the SPEC, then trace consumers. Hand-written client types are where these bugs hide (a CLI type declaring `isDefault` for wire `is_default` compiled fine and read undefined).

Method (two-way, spec-derived):
1. From Agent B's discovered wire field set (or by parsing the OpenAPI sources yourself), build the list of snake_case wire fields. For each, search the consumers for a camelCase read of the same concept (wire `oauth_email` → grep `oauthEmail`; `is_default` → `isDefault`; `reasoning_level` → `reasoningLevel`). A camelCase read of a snake_case wire field → BUG (undefined at runtime).
2. Independently, flag hand-written interfaces that describe a wire response instead of deriving from `@appstrate/shared-types` or the typed client (`apps/web/src/api/schema.d.ts`), and check each field against the spec.

Classify each hit:
- Reading from a wire DTO / typed-client response → BUG if the name does not match the spec
- Reading from a Drizzle row passed through internally → OK (Drizzle TS stays camelCase)
- profile/Better Auth shape → OK (4a/4c); model-provider 4e name → OK; SSE frame → OK (4h, camelCase top level)
- Internal variable / function arg / React prop → OK (Zone 3)

Output: bug list with file + symbol and the actual variable type; report which snake_case wire fields were checked for a camelCase consumer (coverage).
```

### Agent E — Carve-outs

```
Mission: verify every carve-out (4a–4t) and asymmetry (5a–5d) is correctly applied AND correctly documented. Read `docs/CASING_CONVENTIONS.md` Zone 4 and Zone 5 in full.

For each carve-out:
4a. Better Auth + plugin tables (packages/db/src/schema/{auth,oidc}.ts): all camelCase TS; the platform tables in oidc.ts (oidcEndUserProfiles, spaceSmtpConfigs, spaceSocialProviders) have snake_case wire DTOs
4b. Universal DB convention fields (incl. `runId`): camelCase EVERYWHERE (wire + Drizzle + query strings + frontend)
4c. Profile/Member DTOs: only the listed names camelCase
4d. Module hook contracts (packages/core/src/module.ts): the doc's type list matches the file
4e. Model-provider names: name-based — only the listed names camelCase in credential, org-model, pairing and registry objects; the per-object table matches the routes (apps/api/src/routes/model-provider-credentials.ts, model-providers-oauth.ts, models.ts, internal.ts)
4f. Connect-helper internal types camelCase; its redeem body spelled per 4e
4g. JSONB contracts — the boundary rule: for each jsonb() column, is it returned/accepted verbatim? Platform-written + verbatim → interior snake_case (check the writers: notifications payloads, runs.metadata, spaces.settings.branding, run_logs.data markers, generation settings); client/agent-supplied → opaque; never verbatim → producer casing. The doc's three tables must list every jsonb() column.
4h. SSE: `snakeToCamel` in apps/api/src/services/realtime.ts; the channel list matches packages/shared-types/src/realtime-events.ts
4i. Run events: packages/afps-runtime/src/types/canonical-events.ts + run-result.ts camelCase; `file.published` carries `fileId`
4j. Webhooks: delivery envelope + payload camelCase end-to-end
4k. BullMQ: every `createQueue<…>` data type is in the doc's table
4l. Logger fields: spot-check pino calls
4m. Audit log: every `before`/`after` typed `AuditPayload`; no cast hiding a snake_case key
4n. Headless-platform fields: the listed names only; every list goes through `listResponse`
4o. Chat turn metadata camelCase
4p. Agent tool arguments (runtime-pi/sidecar/mcp.ts, packages/afps-runtime/src/resolvers/): the listed names; the platform MCP server's tool args (apps/api/src/modules/mcp/tools.ts) snake_case
4q. AFPS bundle container (packages/afps-runtime/src/bundle/)
4r. ExecutionContext (packages/afps-runtime/src/types/execution-context.ts)
4s. Firecracker runner protocol (apps/api/src/modules/firecracker/runner/protocol.ts)
4t. Sidecar / container boot contracts (packages/core/src/sidecar-types.ts, apps/api/src/services/orchestrator/sidecar-env.ts, packages/runner-pi/src/container-env.ts); the /internal/* HTTP endpoints are Zone 1
5a–5d. Each asymmetry still exists exactly on the surfaces the doc names, and nowhere else

Output: per-carve-out ✅/🔴 verdict + any violation found + any place the doc and the code disagree.
```

### Agent F — Cross-repo + tests

```
Mission: verify cross-repo coherence + test fixtures.

Repos (audit `origin/main` of each: `git fetch`, then `git grep … origin/main` — a local clone may be stale):
- docs (sibling repo), website, connect-helper, afps-spec
- github-action — the clone lives at /Users/pierrecabriere/Dev/_appstrate_dev/github-action; audit its origin/main, not the checked-out branch

Not in this list, and do not add them back: `module-claude-code` and `cloud` (moved in-tree as `packages/module-claude-code` and `packages/module-ee` — already covered by the in-tree `packages/` scope), `registry` and `portal` (retired products, same reason they left the core lockstep gate in #1033).

For each:
- Grep for any 1.x manifest residue (displayName, schemaVersion, fileConstraints, etc.)
- Grep for reads/writes of wire names the platform renamed (a client sending `model_id` on a run-launch body or `credential_id` to `/discover`, reading `requestId` from a problem document, posting `accessToken` to the redeem route)
- Classify: legit (internal TS, banner, historical changelog) vs bug

Test fixtures inside appstrate:
- e2e/helpers/seed.ts
- apps/api/test/**/seed*.ts and helpers
- system-packages/ manifest.json files
- local-test-packages/ manifest.json files

Verify all test fixtures use canonical snake_case AFPS + camelCase carve-out names where applicable; a fixture that mirrors a bug (camelCase key for a snake_case wire field) is a BUG.

Output: per-repo verdict (with the ref audited) + per-fixture-category status.
```

## Final assembly

After all 6 agents return:

1. Sum the total bugs across all reports (a red automated gate counts as a bug)
2. Build the per-zone table
3. List "verified clean" surfaces (high-level — not every file, but every category)
4. Compute global verdict:
   - 0 bugs + 0 drift → ✅ 100% compliant
   - 0 bugs + some drift → 🟡 minor drift, optional cleanup
   - 1+ bug → 🔴 must fix
5. Surface findings to user, ask for next step (fix all / fix subset / ignore)
