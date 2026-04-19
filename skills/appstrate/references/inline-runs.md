# Inline Runs

- [Execute](#execute)
- [Dry-run validation](#dry-run-validation)
- [Ephemeral shadow packages](#ephemeral-shadow-packages)
- [Daily compaction](#daily-compaction)
- [Config snapshot (applies to ALL runs, inline + classic)](#config-snapshot-applies-to-all-runs-inline--classic)
- [Global run list](#global-run-list)
- [Environment limits: `INLINE_RUN_LIMITS`](#environment-limits-inline_run_limits)
- [When to use inline vs package import](#when-to-use-inline-vs-package-import)
- [Gotchas](#gotchas)

Run an agent defined entirely in the request body — no `.afps` import, no package lifecycle, no version history. The platform creates an **ephemeral shadow package** (`ephemeral = true`, scope `@inline/r-<uuid>`), runs it through the standard pipeline, and compacts the manifest/prompt after 24h (configurable). Perfect for one-shot agents, rapid iteration, or integrating Appstrate as an LLM backend.

Two endpoints:

- `POST /api/runs/inline` — execute
- `POST /api/runs/inline/validate` — dry-run preflight (no shadow row, no pipeline, no credits)

## Execute

```bash
curl -X POST "$APPSTRATE_URL/api/runs/inline" \
  -H "Authorization: Bearer $APPSTRATE_API_KEY" \
  -H "X-Org-Id: $APPSTRATE_ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "manifest": {
      "$schema": "https://afps.appstrate.dev/schema/v1/agent.schema.json",
      "name": "@inline/one-shot",
      "displayName": "One-shot summary",
      "version": "0.0.0",
      "type": "agent",
      "schemaVersion": "1.0",
      "dependencies": {
        "tools": { "@appstrate/output": "^1.0.0" }
      }
    },
    "prompt": "Summarize the attached document in three bullet points.",
    "input": { "docId": "doc_123" }
  }'
```

Response `202 Accepted`:

```json
{ "runId": "run_cm1abc123", "packageId": "@inline/r-abc12345-..." }
```

Stream progress: `GET /api/realtime/runs/{runId}` (SSE). Or poll `GET /api/runs/{runId}`.

### Request body

| Field              | Type                       | Required | Notes                                                                                                                                        |
| ------------------ | -------------------------- | :------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`         | object                     |   yes    | Full AFPS agent manifest. Dependencies must reference **existing** org/system skills/tools/providers — registry-only, no inline new packages |
| `prompt`           | string                     |   yes    | Contents of `prompt.md`                                                                                                                      |
| `input`            | object                     |    no    | Validated against `manifest.input.schema` (AJV)                                                                                              |
| `config`           | object                     |    no    | Per-run config overrides validated against `manifest.config.schema` (AJV)                                                                    |
| `providerProfiles` | `Record<providerId, uuid>` |    no    | Override caller's default connection profile per provider                                                                                    |
| `modelId`          | string \| null             |    no    | Per-run model override                                                                                                                       |
| `proxyId`          | string \| null             |    no    | Per-run proxy override, or `"none"` to disable                                                                                               |

### Response codes

| Code | Meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| 202  | Run accepted, `{ runId, packageId }` returned                                         |
| 400  | Invalid manifest, schema mismatch, oversized payload, or wildcard URI when disallowed |
| 401  | Auth missing                                                                          |
| 409  | Idempotency key in progress                                                           |
| 422  | Idempotency body mismatch                                                             |
| 429  | Rate limit (see `INLINE_RUN_LIMITS`)                                                  |

## Dry-run validation

Same body, no side effects. Lets you iterate on a manifest without burning runs or leaving phantom rows.

```bash
curl -X POST "$APPSTRATE_URL/api/runs/inline/validate" \
  -H "Authorization: Bearer $APPSTRATE_API_KEY" \
  -H "X-Org-Id: $APPSTRATE_ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{ "manifest": {...}, "prompt": "...", "input": {...}, "config": {...} }'
```

Runs the same preflight as execute (manifest shape → config/input AJV → provider readiness).

| Code | Body                                              |
| ---- | ------------------------------------------------- |
| 200  | `{ "ok": true }`                                  |
| 400  | `application/problem+json` with the first failure |

**Shares the same rate bucket as `/api/runs/inline`** — tight iteration loops can trigger 429.

## Ephemeral shadow packages

Inline runs create a hidden `packages` row:

- `ephemeral = true`
- `name` in reserved scope `@inline/r-<uuid>`
- Never appears in catalog queries (`GET /api/agents`, `/api/packages/*`)
- `runs.agent_scope` / `runs.agent_name` denormalized — survives package compaction
- Runs surface with `packageEphemeral: true` in the global run list

You can link directly to an inline run detail: `/agents/@inline/r-.../runs/:runId` (the UI detects the shadow scope and skips the agent detail query).

## Daily compaction

A background worker runs daily:

- NULLs `draft_manifest` + `draft_content` on ephemeral packages older than `retention_days` (default 30)
- Drops associated `run_logs` via the `run_id` join
- Never hard-deletes the `packages` row (FK cascade would drop the run)
- Active runs are protected — their logs are preserved

After compaction, the run row keeps status/result/input/output/cost/tokens but `inlineManifest` and `inlinePrompt` are `null`. The UI shows **"Details expired"** in the run detail view.

## Config snapshot (applies to ALL runs, inline + classic)

Every run — classic AND inline — now persists the effective agent config at creation time in `runs.config`. The Run Info tab renders it under a **Configuration** section, so users can always see what settings were active for a given run, decoupled from the package's current config.

This means: editing a package's config after a run never rewrites history. Each run is self-describing.

## Global run list

New endpoint for cross-agent visibility:

```
GET /api/runs?kind=inline&status=success&startDate=2026-04-01T00:00:00Z
```

| Query                   | Values                                                  |
| ----------------------- | ------------------------------------------------------- |
| `user`                  | `me` (self-view — ignores `kind`/`status`/date filters) |
| `kind`                  | `all` \| `package` \| `inline`                          |
| `status`                | any run status                                          |
| `startDate` / `endDate` | ISO 8601 date-time                                      |
| `limit`                 | 1-100, default 20                                       |
| `offset`                | default 0                                               |

Each row includes `packageEphemeral: boolean` so clients can render an inline badge.

## Environment limits: `INLINE_RUN_LIMITS`

Configured as a JSON object in the `INLINE_RUN_LIMITS` env var. Strictly validated at boot — unknown keys fail-fast.

| Key                    | Default | Meaning                                        |
| ---------------------- | ------- | ---------------------------------------------- |
| `rate_per_min`         | 60      | Per-user rate bucket (shared with `/validate`) |
| `manifest_bytes`       | 65536   | Max serialized manifest size                   |
| `prompt_bytes`         | 200000  | Max UTF-8 prompt size                          |
| `max_skills`           | 20      | Max skill dependencies                         |
| `max_tools`            | 20      | Max tool dependencies                          |
| `max_authorized_uris`  | 50      | Max per-provider `authorizedUris` entries      |
| `wildcard_uri_allowed` | false   | Whether `*` is allowed in `authorizedUris`     |
| `retention_days`       | 30      | Days before compaction NULLs manifest/prompt   |

Also governed by the broader `PLATFORM_RUN_LIMITS` (shared with every run path):
`timeout_ceiling_seconds` (1800), `per_org_global_rate_per_min` (200), `max_concurrent_per_org` (50).

## When to use inline vs package import

| Use inline                                          | Use package import                           |
| --------------------------------------------------- | -------------------------------------------- |
| One-shot agent, no reuse                            | Agent needs a stable name / version history  |
| Rapid iteration during development                  | Scheduled runs (schedules require a package) |
| Integrating Appstrate as an LLM backend             | End users install via UI                     |
| Dynamic manifest composed at call site              | Publishing for other orgs/users              |
| You don't need the agent to appear in `/api/agents` | —                                            |

## Gotchas

1. **Dependencies are registry-only** — Inline manifests can depend on skills/tools/providers by ID, but cannot define new ones inline. If a dep doesn't exist in org/system catalog, preflight fails with 400.
2. **Not schedulable** — Schedules require a persisted package. Schedule a regular agent instead.
3. **Validate shares the rate bucket** — Iterative dev loops calling `/validate` every keystroke will hit 429. Debounce.
4. **`manifest_bytes` is serialized JSON size** — Not the number of dependencies. A manifest with many defaults/descriptions can exceed the limit.
5. **`@inline/r-...` scope is reserved** — Don't try to publish a package in that scope.
6. **Compaction is irreversible** — Once `inlineManifest`/`inlinePrompt` are NULLed, there is no recovery. For audit needs, log the manifest client-side before calling.
