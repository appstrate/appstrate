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
            "Version query to execute (exact version, dist-tag, or semver range). When provided, the run uses the versioned manifest and prompt instead of the live agent.",
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
              },
            },
            example: {
              input: { message: "Summarize my latest emails" },
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
            Sunset: { $ref: "#/components/headers/Sunset" },
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
            "Agent readiness validation failed (empty prompt, missing skill/tool, provider not connected, or incomplete config)",
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
                  runs: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Run" },
                  },
                  total: { type: "integer" },
                },
                required: ["runs", "total"],
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
                    "Full AFPS manifest (agent type). All referenced skills/tools/providers must already exist in the org or system catalog — registry-only dependencies.",
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
                providerProfiles: {
                  type: "object",
                  additionalProperties: { type: "string", format: "uuid" },
                  description:
                    "Map of providerId → connection-profile UUID. Per-provider override layered over the caller's default profile.",
                },
                modelId: { type: ["string", "null"] },
                proxyId: { type: ["string", "null"] },
              },
            },
            example: {
              manifest: {
                $schema: "https://afps.appstrate.dev/schema/v1/agent.schema.json",
                name: "@inline/one-shot",
                displayName: "One-shot summary",
                version: "0.0.0",
                type: "agent",
                schemaVersion: "1.1",
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "409": { $ref: "#/components/responses/IdempotencyInProgress" },
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
        "Dry-run validator. Runs the same preflight as `POST /api/runs/inline` — manifest shape, config + input against manifest schemas, and provider readiness — but never inserts a shadow package, never fires the pipeline, and never consumes run credits. Returns `200 { ok: true }` on success, `400` problem+json otherwise. Lets developers iterate on a manifest without leaving run history behind.\n\n**Rate limit:** shares the same per-user bucket as `POST /api/runs/inline` (`INLINE_RUN_LIMITS.rate_per_min`). Iterative validation calls count against the same quota as actual runs — tight loops can trigger `429`.",
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
                providerProfiles: {
                  type: "object",
                  additionalProperties: { type: "string", format: "uuid" },
                },
                modelId: { type: ["string", "null"] },
                proxyId: { type: ["string", "null"] },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Manifest + inputs + provider readiness all pass",
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
          description: "Invalid manifest, schema mismatch, or missing provider readiness",
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
        "Org + application scoped paginated list. Supports filtering by `user=me` (self-owned, also implicit for end-user impersonation), `kind` (all, package, inline), `status`, and a date range. Inline runs surface via `packageEphemeral: true` on each row. Note: `kind`, `status`, and date filters are ignored when `user=me` (self-view uses a simpler path).",
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
                required: ["runs", "total"],
                properties: {
                  runs: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Run" },
                  },
                  total: { type: "integer" },
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
                dashboardUserId: "usr_k7x9m2p4q1",
                orgId: "org_r3t5w8y1z6",
                status: "success",
                input: { folder: "inbox", maxEmails: 50 },
                result: { processed: 42, labeled: 38 },
                state: { lastProcessedId: "msg_99f2a" },
                tokenUsage: {
                  input_tokens: 8200,
                  output_tokens: 4250,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 1024,
                },
                startedAt: "2026-01-15T10:30:00Z",
                completedAt: "2026-01-15T10:31:12Z",
                duration: 72000,
                connectionProfileId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                scheduleId: "sched_cm1abc456def789",
                versionLabel: "1.2.0",
                versionDirty: false,
                proxyLabel: null,
                modelLabel: "Claude Sonnet 4",
                modelSource: "system",
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
      description: "Get persisted log entries for a run.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
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
                  type: "object",
                  required: ["kind", "manifest", "prompt"],
                  properties: {
                    kind: { const: "inline" },
                    manifest: {
                      type: "object",
                      description:
                        "Full AFPS manifest (agent type). All referenced skills/tools/providers must already exist in the org or system catalog.",
                    },
                    prompt: { type: "string", minLength: 1 },
                    providerProfiles: {
                      type: "object",
                      additionalProperties: { type: "string" },
                    },
                    config: { type: "object" },
                    modelId: { type: ["string", "null"] },
                    proxyId: { type: ["string", "null"] },
                  },
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
                    ttlSeconds: {
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
                required: ["runId", "url", "finalizeUrl", "secret", "expiresAt"],
                properties: {
                  runId: { type: "string" },
                  url: {
                    type: "string",
                    format: "uri",
                    description: "Absolute URL for `HttpSink.url`.",
                  },
                  finalizeUrl: {
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": { $ref: "#/components/responses/IdempotencyInProgress" },
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
                "AFPS runtime `RunResult` — `memories`, `state`, `output`, `report`, `logs` plus optional terminal `status`/`error`/`durationMs`.",
              properties: {
                memories: { type: "array" },
                state: {},
                output: {},
                report: { type: ["string", "null"] },
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
  "/api/runs/{runId}/sink/extend": {
    patch: {
      operationId: "extendRunSink",
      tags: ["Runs"],
      summary: "Extend the sink expiry for a long-running remote run",
      description:
        "Pushes `sink_expires_at` out to `now() + ttlSeconds`, clamped to `REMOTE_RUN_SINK_MAX_TTL_SECONDS`. Only open sinks (not closed, not already expired) owned by the caller's org can be extended; mismatches return 404 to avoid cross-tenant leaks.",
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
              required: ["ttlSeconds"],
              properties: {
                ttlSeconds: { type: "integer", minimum: 1, maximum: 86400 },
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
