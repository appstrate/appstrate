// SPDX-License-Identifier: Apache-2.0

export const runsPaths = {
  "/api/agents/{scope}/{name}/run": {
    post: {
      operationId: "runAgent",
      tags: ["Runs"],
      summary: "Execute an agent",
      description:
        "Start an agent run (fire-and-forget). Returns the run ID. Rate-limited to 20/min. Supports JSON body or multipart/form-data with file uploads.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/AppstrateUser" },
        { $ref: "#/components/parameters/AppstrateVersion" },
        { $ref: "#/components/parameters/IdempotencyKey" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "version",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Which agent definition to execute: `draft` (the live editor working copy), `published` (the latest published version — 404 `no_published_version` if nothing is published), or a version spec (exact version, dist-tag, or semver range; 3-step resolution). **Default when omitted: the latest published version when one exists, the draft otherwise** — programmatic callers (API, MCP, CLI, CI) run what was published unless they explicitly ask for the draft. The editor UI passes `version=draft` for test-runs. The run object's `version_ref` states which definition executed. Ignored for system agents.",
        },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                input: { type: "object", description: "Run input values" },
                modelId: {
                  type: "string",
                  description:
                    "Model ID override for this run. Takes priority over agent and org defaults.",
                },
                proxyId: {
                  type: "string",
                  description:
                    'Proxy ID override for this run, or "none" to disable proxying. Takes priority over agent and org defaults.',
                },
                config: {
                  type: "object",
                  description:
                    "Per-run config override. Deep-merged with the per-application persisted config (`application_packages.config`): override leaves replace, plain-object children merge recursively, arrays are replaced wholesale, `null` at a leaf sets the value to null (validated as missing for required string fields), missing keys fall through. Re-validated against the manifest config schema after the merge — a 400 `invalid_config` is returned if the merged result violates the schema. Top-level `null` is rejected (returns 400) — omit the field to inherit persisted defaults, send `{}` for an explicit empty override. Mirrors the OpenAPI Assistants `runs.create { instructions, model, tools }` and Argo Workflows `submitOptions.parameters` SOTA — every client (UI, CLI, SDK) reaches the same resolved config for the same `(persisted, override)` pair.",
                },
                connection_overrides: {
                  type: "object",
                  description:
                    'Per-integration connection picks for THIS run (flat-connections mechanism #2). Flat map: `{ "@scope/integration": "<connection_id>" }` — one connection per integration; the chosen connection carries its own authKey. Loses to admin pins (mechanism #1), beats the schedule-frozen layer (#3) and the actor-fallback (#4). Resolved at kickoff, persisted on `runs.connection_overrides` and snapshotted into `runs.resolved_connections` so the spawn loader + MITM credentials refresh honour the same pick. Returns 412 `missing_integration_connection` if the chosen id is not accessible to the actor.',
                  additionalProperties: { type: "string" },
                },
              },
            },
            example: {
              input: { message: "Summarize my latest emails" },
              config: { dryRun: true },
            },
          },
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: {
                input: { type: "string", description: "JSON-encoded input values" },
                file: { type: "string", format: "binary", description: "File upload" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Run started",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  runId: { type: "string" },
                },
              },
              example: {
                runId: "run_cm1abc123def456",
              },
            },
          },
        },
        "400": {
          description:
            "Agent readiness validation failed (empty prompt, missing skill, or incomplete config)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "402": {
          description: "Quota exceeded (Cloud only)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { $ref: "#/components/responses/IdempotencyInProgress" },
        "412": {
          description: "Missing integration connection (`missing_integration_connection`)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "422": { $ref: "#/components/responses/IdempotencyConflict" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/agents/{scope}/{name}/runs": {
    get: {
      operationId: "listAgentRuns",
      tags: ["Runs"],
      summary: "List runs for an agent",
      description: "List runs for a specific agent (org-scoped, default limit 50).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
        {
          name: "offset",
          in: "query",
          schema: { type: "integer", minimum: 0, default: 0 },
        },
      ],
      responses: {
        "200": {
          description: "Paginated run list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Run" },
                  },
                  total: { type: "integer" },
                  hasMore: { type: "boolean" },
                },
                required: ["object", "data", "total", "hasMore"],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
    delete: {
      operationId: "deleteAgentRuns",
      tags: ["Runs"],
      summary: "Delete all runs for an agent",
      description: "Delete all completed runs for an agent.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Runs deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { deleted: { type: "integer" } },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description: "Running runs exist",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Conflict",
                status: 409,
                detail: "Cannot delete runs while agent has active runs",
                code: "conflict",
                requestId: "req_abc123",
              },
            },
          },
        },
      },
    },
  },
  "/api/runs/inline": {
    post: {
      operationId: "runInline",
      tags: ["Runs"],
      summary: "Execute an inline agent (no persisted package)",
      description:
        "Run an agent defined entirely in the request body. The platform creates a shadow `packages` row (ephemeral = true), runs it through the standard pipeline, and returns `202 { runId, packageId }`. Stream progress via `GET /api/realtime/runs/{id}`. See `docs/specs/INLINE_RUNS.md`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/AppstrateUser" },
        { $ref: "#/components/parameters/AppstrateVersion" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["manifest", "prompt"],
              properties: {
                manifest: {
                  type: "object",
                  description:
                    "Full AFPS manifest (agent type). All referenced skills/integrations must already exist in the org or system catalog — registry-only dependencies.",
                },
                prompt: {
                  type: "string",
                  description: "Contents of prompt.md — the agent's system prompt.",
                },
                input: {
                  type: "object",
                  description: "Run input validated against manifest.input.schema (AJV).",
                },
                config: {
                  type: "object",
                  description:
                    "Per-run config overrides validated against manifest.config.schema (AJV).",
                },
                modelId: { type: ["string", "null"] },
                proxyId: { type: ["string", "null"] },
              },
            },
            example: {
              manifest: {
                $schema: "https://schemas.afps.dev/v0/agent.schema.json",
                name: "@inline/one-shot",
                display_name: "One-shot summary",
                version: "0.0.0",
                type: "agent",
                schema_version: "0.1",
                dependencies: {},
              },
              prompt: "Summarize the attached document in three bullet points.",
              input: { docId: "doc_123" },
            },
          },
        },
      },
      responses: {
        "202": {
          description: "Inline run accepted — stream via SSE",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["runId", "packageId"],
                properties: {
                  runId: { type: "string" },
                  packageId: {
                    type: "string",
                    description:
                      "Shadow package id (reserved `@inline/r-<uuid>` scope). Hidden from catalog queries.",
                  },
                },
              },
              example: { runId: "run_cm1abc123", packageId: "@inline/r-abc12345-..." },
            },
          },
        },
        "400": {
          description:
            "Invalid manifest, oversized payload, wildcard URI when disallowed, or schema validation failure",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "402": {
          description: "Quota exceeded (Cloud only)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "409": { $ref: "#/components/responses/IdempotencyInProgress" },
        "412": {
          description: "Missing integration connection (`missing_integration_connection`)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "422": { $ref: "#/components/responses/IdempotencyConflict" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/runs/inline/validate": {
    post: {
      operationId: "validateInlineRun",
      tags: ["Runs"],
      summary: "Validate an inline manifest without firing a run",
      description:
        "Dry-run validator. Runs the same preflight as `POST /api/runs/inline` — manifest shape, config + input against manifest schemas, and integration readiness — but never inserts a shadow package, never fires the pipeline, and never consumes run credits. Returns `200 { ok: true }` on success, `400` problem+json otherwise. Lets developers iterate on a manifest without leaving run history behind.\n\n**Rate limit:** shares the same per-user bucket as `POST /api/runs/inline` (`INLINE_RUN_LIMITS.rate_per_min`). Iterative validation calls count against the same quota as actual runs — tight loops can trigger `429`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/AppstrateUser" },
        { $ref: "#/components/parameters/AppstrateVersion" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["manifest", "prompt"],
              properties: {
                manifest: { type: "object" },
                prompt: { type: "string" },
                input: { type: "object" },
                config: { type: "object" },
                modelId: { type: ["string", "null"] },
                proxyId: { type: ["string", "null"] },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Manifest + inputs + integration readiness all pass",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean", enum: [true] } },
              },
              example: { ok: true },
            },
          },
        },
        "400": {
          description: "Invalid manifest, schema mismatch, or missing connection readiness",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/runs": {
    get: {
      operationId: "listRuns",
      tags: ["Runs"],
      summary: "List runs across the application (global view)",
      description:
        "Org + application scoped paginated list. Supports filtering by `user=me` (self-owned, also implicit for end-user impersonation), `kind` (all, package, inline), `status`, and a date range. Inline runs surface via `package_ephemeral: true` on each row. Note: `kind`, `status`, and date filters are ignored when `user=me` (self-view uses a simpler path).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/AppstrateUser" },
        {
          name: "user",
          in: "query",
          schema: { type: "string", enum: ["me"] },
          description:
            "Filter runs by user. `me` returns only the current user's runs. Omit for all org runs.",
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        {
          name: "kind",
          in: "query",
          schema: { type: "string", enum: ["all", "package", "inline"] },
        },
        { name: "status", in: "query", schema: { type: "string" } },
        { name: "startDate", in: "query", schema: { type: "string", format: "date-time" } },
        { name: "endDate", in: "query", schema: { type: "string", format: "date-time" } },
      ],
      responses: {
        "200": {
          description: "Paginated run list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "total", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Run" },
                  },
                  total: { type: "integer" },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "400": {
          description: "Invalid query parameter (e.g. malformed date)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/runs/{id}": {
    get: {
      operationId: "getRun",
      tags: ["Runs"],
      summary: "Get run status/result",
      description: "Get run details including status, result, input, and duration.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Run detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Run" },
              example: {
                id: "run_cm1abc123def456",
                packageId: "@acme/email-sorter",
                userId: "usr_k7x9m2p4q1",
                orgId: "org_r3t5w8y1z6",
                status: "success",
                input: { folder: "inbox", maxEmails: 50 },
                result: { processed: 42, labeled: 38 },
                checkpoint: { lastProcessedId: "msg_99f2a" },
                token_usage: {
                  input_tokens: 8200,
                  output_tokens: 4250,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 1024,
                },
                started_at: "2026-01-15T10:30:00Z",
                completed_at: "2026-01-15T10:31:12Z",
                duration: 72000,
                scheduleId: "sched_cm1abc456def789",
                version_label: "1.2.0",
                version_dirty: false,
                version_ref: "1.2.0",
                proxy_label: null,
                model_label: "Claude Sonnet 4",
                model_source: "system",
                cost: 0.0034,
                endUserId: null,
                applicationId: "app_m4n5o6p7",
                metadata: null,
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/runs/{id}/logs": {
    get: {
      operationId: "getRunLogs",
      tags: ["Runs"],
      summary: "Get run logs",
      description:
        "Get persisted log entries for a run. Pass `?since=<id>` to receive only entries with `id > since` — the cursor used by the CLI's polling tail to bound per-poll payload growth. `id` is a monotonic BIGSERIAL; an invalid cursor falls back to the full list rather than 400.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "since",
          in: "query",
          required: false,
          schema: { type: "integer", format: "int64", minimum: 0 },
          description:
            "Return only log entries with `id > since`. Used by the CLI's `appstrate run` remote polling loop to fetch incremental tails without re-shipping the full history each poll.",
        },
      ],
      responses: {
        "200": {
          description: "Log entries",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/RunLog" },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/runs/{id}/cancel": {
    post: {
      operationId: "cancelRun",
      tags: ["Runs"],
      summary: "Cancel a run",
      description: "Cancel a running or pending run.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Run cancelled",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { type: "object", properties: { ok: { type: "boolean" } } },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Run not cancellable (already completed/failed)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Conflict",
                status: 409,
                detail: "Run has already completed and cannot be cancelled",
                code: "conflict",
                requestId: "req_def456",
              },
            },
          },
        },
      },
    },
  },
  "/api/runs/remote": {
    post: {
      operationId: "createRemoteRun",
      tags: ["Runs"],
      summary: "Create a remote-backed run (caller executes the agent)",
      description:
        "Create a run whose agent process runs on the caller's host (CLI, GitHub Action, self-hosted runner) instead of inside a platform container. Returns ephemeral HMAC-signed sink credentials the caller plugs into `HttpSink` to stream `RunEvent`s back via `POST /api/runs/{runId}/events`. The secret is returned exactly once and is never retrievable afterwards. Status lifecycle (`pending` → `running` → terminal) flows through the signed-event ingestion routes. Matches the quota/rate-limit gates of classic runs: `per_org_global_rate_per_min` and `max_concurrent_per_org` both apply. See `docs/specs/REMOTE_CLI_UNIFIED_RUNNER_PLAN.md`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/AppstrateVersion" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["source", "applicationId"],
              properties: {
                source: {
                  description:
                    "Two attribution shapes: `inline` ships the manifest+prompt in the body (ad-hoc agents — always lands on a shadow ephemeral package); `registry` declares the package by id and the server reads the manifest from its own catalog (deterministic attribution, no fingerprint reconciliation).",
                  oneOf: [
                    {
                      type: "object",
                      required: ["kind", "manifest", "prompt"],
                      properties: {
                        kind: { const: "inline" },
                        manifest: {
                          type: "object",
                          description:
                            "Full AFPS manifest (agent type). All referenced skills/integrations must already exist in the org or system catalog.",
                        },
                        prompt: { type: "string", minLength: 1 },
                        config: { type: "object" },
                        modelId: { type: ["string", "null"] },
                        proxyId: { type: ["string", "null"] },
                      },
                    },
                    {
                      type: "object",
                      required: ["kind", "packageId"],
                      properties: {
                        kind: { const: "registry" },
                        packageId: {
                          type: "string",
                          minLength: 1,
                          description: "Scoped package id (`@scope/name`).",
                        },
                        stage: {
                          type: "string",
                          enum: ["draft", "published"],
                          default: "published",
                          description:
                            "`draft` reads `draft_manifest`/`draftContent` (mutable, mirrors the dashboard Run button on never-published agents); `published` resolves a concrete `package_versions` row.",
                        },
                        spec: {
                          type: "string",
                          description:
                            "Version, semver range, or dist-tag. Only valid with `stage: published`. Resolution falls back to the version installed in the application, then to the `latest` dist-tag.",
                        },
                        integrity: {
                          type: "string",
                          description:
                            "Optional SRI digest (`sha256-…`) the runner received with the bundle download. Triggers a structured warn-log when the resolved version's stored artifact integrity diverges (dist-tag drift, mid-flight draft edit). Never a rejection signal.",
                        },
                        config: { type: "object" },
                        modelId: { type: ["string", "null"] },
                        proxyId: { type: ["string", "null"] },
                      },
                    },
                  ],
                },
                applicationId: { type: "string", minLength: 1 },
                input: { type: "object" },
                contextSnapshot: {
                  type: "object",
                  description:
                    "Caller-provided execution-environment metadata (os, cli version, git sha). Capped at 16 KiB serialised.",
                },
                sink: {
                  type: "object",
                  properties: {
                    ttl_seconds: {
                      type: "integer",
                      minimum: 1,
                      maximum: 86400,
                      description:
                        "Requested sink lifetime in seconds. Clamped to REMOTE_RUN_SINK_MAX_TTL_SECONDS (default 24h).",
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Run created — use the returned credentials to stream events",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["runId", "url", "finalize_url", "secret", "expiresAt"],
                properties: {
                  runId: { type: "string" },
                  url: {
                    type: "string",
                    format: "uri",
                    description: "Absolute URL for `HttpSink.url`.",
                  },
                  finalize_url: {
                    type: "string",
                    format: "uri",
                    description: "Absolute URL for `HttpSink.finalizeUrl`.",
                  },
                  secret: {
                    type: "string",
                    description:
                      "32-byte ephemeral secret, base64url-encoded. Returned once and never retrievable afterwards.",
                  },
                  expiresAt: {
                    type: "string",
                    format: "date-time",
                    description: "ISO-8601. Events posted after this timestamp reject with 410.",
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "402": {
          description: "Quota exceeded (Cloud only)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": { $ref: "#/components/responses/IdempotencyInProgress" },
        "412": {
          description: "Missing integration connection (`missing_integration_connection`)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "422": { $ref: "#/components/responses/IdempotencyConflict" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/runs/{runId}/events": {
    post: {
      operationId: "ingestRunEvent",
      tags: ["Runs"],
      summary: "Ingest one signed CloudEvent (HMAC)",
      description:
        'Receives a single AFPS `RunEvent` CloudEvent from the run\'s HttpSink. Authenticated via Standard Webhooks HMAC-SHA256 (`webhook-id`, `webhook-timestamp`, `webhook-signature` headers). Idempotent: duplicate `webhook-id` values inside the replay window return `200 { outcome: "replay" }` without reprocessing. Events with non-contiguous sequence numbers are buffered and drained in order on the next contiguous arrival or when a terminal event flushes the buffer.',
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "webhook-id",
          in: "header",
          required: true,
          schema: { type: "string" },
          description: "Idempotency + replay dedup key — typically a UUIDv4.",
        },
        {
          name: "webhook-timestamp",
          in: "header",
          required: true,
          schema: { type: "string", pattern: "^[0-9]+$" },
          description: "Unix seconds. Rejected when outside the 5-minute tolerance window.",
        },
        {
          name: "webhook-signature",
          in: "header",
          required: true,
          schema: { type: "string" },
          description: "`v1,<base64 hmac-sha256>`. Space-separated lists supported for rotation.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/cloudevents+json": {
            schema: {
              type: "object",
              required: [
                "specversion",
                "type",
                "source",
                "id",
                "time",
                "datacontenttype",
                "data",
                "sequence",
              ],
              properties: {
                specversion: { const: "1.0" },
                type: { type: "string" },
                source: { type: "string" },
                id: { type: "string" },
                time: { type: "string", format: "date-time" },
                datacontenttype: { const: "application/json" },
                data: { type: "object" },
                sequence: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
      security: [],
      responses: {
        "200": {
          description: "Event accepted (persisted, buffered, or replay-dedup)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "outcome"],
                properties: {
                  ok: { const: true },
                  outcome: { type: "string", enum: ["persisted", "replay", "buffered"] },
                  sequence: { type: "integer" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": {
          description:
            "missing_signature_headers | invalid_signature | invalid_timestamp | timestamp_out_of_tolerance",
        },
        "404": { description: "run_not_found" },
        "410": { description: "run_sink_closed | run_sink_expired | sink_not_configured" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/runs/{runId}/events/finalize": {
    post: {
      operationId: "finalizeRemoteRun",
      tags: ["Runs"],
      summary: "Terminal RunResult — close the sink (HMAC, idempotent)",
      description:
        "Closes the run. Flushes any buffered events (accepting sequence gaps — no more will arrive), sets terminal status/result/cost/duration on the `runs` row, fires the `afterRun` module hook. Idempotent: a replay after the sink is closed returns `200 { ok: true }` without re-firing hooks.",
      parameters: [
        { name: "runId", in: "path", required: true, schema: { type: "string" } },
        { name: "webhook-id", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-timestamp", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-signature", in: "header", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              description:
                "AFPS runtime `RunResult` — `memories`, `pinned`, `output`, `logs` plus optional terminal `status`/`error`/`durationMs` and the authoritative terminal cost-tracking fields `usage` (token usage) and `cost`.",
              properties: {
                memories: { type: "array" },
                pinned: { type: "object" },
                output: {},
                logs: { type: "array" },
                error: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                    stack: { type: "string" },
                  },
                },
                status: {
                  type: "string",
                  enum: ["success", "failed", "timeout", "cancelled"],
                },
                durationMs: { type: "integer", minimum: 0 },
                usage: {
                  type: "object",
                  description: "Authoritative terminal token usage written to the `runs` row.",
                  properties: {
                    input_tokens: { type: "integer", minimum: 0 },
                    output_tokens: { type: "integer", minimum: 0 },
                    cache_creation_input_tokens: { type: "integer", minimum: 0 },
                    cache_read_input_tokens: { type: "integer", minimum: 0 },
                  },
                },
                cost: {
                  type: "number",
                  minimum: 0,
                  description: "Authoritative terminal run cost written to the `runs` row.",
                },
              },
            },
          },
        },
      },
      security: [],
      responses: {
        "200": {
          description: "Sink closed or already closed",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { const: true } },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { description: "Signature verification failed" },
        "404": { description: "run_not_found" },
        "410": { description: "run_sink_closed | run_sink_expired" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/runs/{runId}/events/heartbeat": {
    post: {
      operationId: "heartbeatRemoteRun",
      tags: ["Runs"],
      summary: "Runner liveness keep-alive (HMAC)",
      description:
        "Proof-of-life beacon posted by the runner itself (platform container, remote CLI, GitHub Action). Bumps `runs.last_heartbeat_at = now()` on an open-sink row — no sequence advance, no log row, no payload. The server's stall watchdog reads `last_heartbeat_at` and finalises runs whose heartbeat has slipped past the threshold, giving every runner topology one unified crash-detection path. Any authenticated event POST is an implicit heartbeat; this endpoint exists for idle periods (agent waiting on an LLM or tool for longer than the heartbeat interval).",
      parameters: [
        { name: "runId", in: "path", required: true, schema: { type: "string" } },
        { name: "webhook-id", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-timestamp", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-signature", in: "header", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              description: "Empty body — the HMAC covers the zero-length payload.",
            },
          },
        },
      },
      security: [],
      responses: {
        "200": {
          description: "Heartbeat accepted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { const: true } },
              },
            },
          },
        },
        "401": { description: "Signature verification failed" },
        "404": { description: "run_not_found" },
        "410": { description: "run_sink_closed | run_sink_expired" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/runs/{runId}/workspace": {
    get: {
      operationId: "fetchRunWorkspace",
      tags: ["Runs"],
      summary: "Fetch the run bundle archive (HMAC)",
      description:
        "Fetched by the agent runtime at startup to self-provision its `/workspace`. Returns the AFPS bundle (`agent-package.afps` = manifest + prompt + skills; itself a ZIP) verbatim — small and constant; the agent writes it straight to its workspace root. Input documents are NOT bundled here; the agent fetches them separately and streams each to disk (`GET /api/runs/{runId}/documents`). This pull-based delivery means workspace correctness no longer depends on a shared run volume's driver (a tmpfs-backed `local` volume is not shared between the seed helper and the agent — see issue #549). Same Standard Webhooks HMAC auth as the event routes: the signature covers the empty GET body. A 404 means no bundle was provisioned, which the runtime treats as a fatal provisioning fault (the platform always uploads the agent package).",
      parameters: [
        { name: "runId", in: "path", required: true, schema: { type: "string" } },
        { name: "webhook-id", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-timestamp", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-signature", in: "header", required: true, schema: { type: "string" } },
      ],
      security: [],
      responses: {
        "200": {
          description: "Bundle archive (ZIP)",
          content: {
            "application/zip": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "401": { description: "Signature verification failed" },
        "404": { description: "run_not_found | no workspace provisioned" },
        "410": { description: "run_sink_closed | run_sink_expired" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/runs/{runId}/documents": {
    get: {
      operationId: "fetchRunDocumentsManifest",
      tags: ["Runs"],
      summary: "List the run's input documents (HMAC)",
      description:
        "Fetched by the agent runtime to enumerate the input documents it must provision. Returns the manifest of documents the run carries; the agent then fetches each via `GET /api/runs/{runId}/documents/{name}`. Same Standard Webhooks HMAC auth as the workspace route. A 404 means the run carries no input documents (the common case), which the runtime treats as an empty document set — not a fault.",
      parameters: [
        { name: "runId", in: "path", required: true, schema: { type: "string" } },
        { name: "webhook-id", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-timestamp", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-signature", in: "header", required: true, schema: { type: "string" } },
      ],
      security: [],
      responses: {
        "200": {
          description: "Documents manifest",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["documents"],
                properties: {
                  documents: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["name", "size"],
                      properties: {
                        name: { type: "string" },
                        size: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "401": { description: "Signature verification failed" },
        "404": { description: "run_not_found | no input documents" },
        "410": { description: "run_sink_closed | run_sink_expired" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/runs/{runId}/documents/{name}": {
    get: {
      operationId: "fetchRunDocument",
      tags: ["Runs"],
      summary: "Fetch a single run input document (HMAC)",
      description:
        "Fetched by the agent runtime for each entry in the documents manifest. The bytes are streamed straight from storage so neither the platform nor the agent buffers the whole document; the agent streams the response body to `documents/{name}` on disk. Same Standard Webhooks HMAC auth as the workspace route. A 404 on a document the manifest listed is a fatal provisioning fault.",
      parameters: [
        { name: "runId", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        { name: "webhook-id", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-timestamp", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-signature", in: "header", required: true, schema: { type: "string" } },
      ],
      security: [],
      responses: {
        "200": {
          description: "Document bytes",
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "401": { description: "Signature verification failed" },
        "404": { description: "run_not_found | document not found" },
        "410": { description: "run_sink_closed | run_sink_expired" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/runs/{runId}/sink/extend": {
    patch: {
      operationId: "extendRunSink",
      tags: ["Runs"],
      summary: "Extend the sink expiry for a long-running remote run",
      description:
        "Pushes `sink_expires_at` out to `now() + ttl_seconds`, clamped to `REMOTE_RUN_SINK_MAX_TTL_SECONDS`. Only open sinks (not closed, not already expired) owned by the caller's org can be extended; mismatches return 404 to avoid cross-tenant leaks.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "runId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["ttl_seconds"],
              properties: {
                ttl_seconds: { type: "integer", minimum: 1, maximum: 86400 },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Sink extended",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["runId", "expiresAt"],
                properties: {
                  runId: { type: "string" },
                  expiresAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
