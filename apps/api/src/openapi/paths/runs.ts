// SPDX-License-Identifier: Apache-2.0

export const runsPaths = {
  "/api/agents/{scope}/{name}/run": {
    post: {
      operationId: "runAgent",
      tags: ["Runs"],
      summary: "Execute an agent",
      description:
        "Start an agent run (fire-and-forget — the response does not wait for execution). Returns `201` + the created run resource — same shape as `GET /runs/{id}` — including the resolved `model_label` / `model_source`. Rate-limited to 20/min. " +
        "The body is JSON. File-typed input fields (`format: uri` + `contentMediaType` in the " +
        "agent's input schema) accept either of two forms: " +
        "(1) an `upload://upl_xxx` reference from `createUpload` — stage the bytes first by " +
        "PUTting them to the signed URL (see `createUpload` for the step-by-step recipe); or " +
        "(2) an inline RFC 2397 data URI `data:<mime>;name=<filename>;base64,<payload>` with up " +
        "to 4 MiB of decoded content (`name` is optional) — the single-call path for JSON-only " +
        "clients such as MCP. Inline bytes are written to the run workspace as a document and " +
        "the payload is stripped from the persisted run input (the stored value keeps only a " +
        "`data:<mime>;name=<doc>;base64,` marker). Declared binary MIMEs are verified by " +
        "magic-byte sniffing in both forms. " +
        "Send `rerun_from` instead of `input` to replay a previous run's input — same documents, " +
        "new overrides — without re-uploading. " +
        "The effective model is resolved at run creation with precedence: request `modelId` > " +
        "agent model setting > org default model > system default. Without an explicit `modelId`, " +
        "a change to the org default model between triggers applies to the next run — send " +
        "`modelId` to pin a specific model per run. " +
        "A run against a published version assembles its bundle from stored artifacts before " +
        "the container starts, so a bad artifact fails the trigger rather than the run: `422 " +
        "dependency_unresolved` (a pin with no published version), `422 bundle_invalid` (the " +
        "stored archive cannot be assembled), `422 bundle_signature_invalid` (rejected by " +
        "`AFPS_SIGNATURE_POLICY`), or `500 bundle_integrity_mismatch` (the stored bytes no " +
        "longer match the integrity hash recorded at publish time — republish the package). " +
        "No run row is created in any of those cases.",
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
            "Which agent definition to execute: `draft` (the live editor working copy), `published` (the latest published version), or a version spec (exact version, dist-tag, or semver range; 3-step resolution). **Omitting the parameter is strictly identical to `published`** — the latest published version, or `404 no_published_version` when nothing is published. The working copy is NEVER an implicit default: run it by passing `version=draft` explicitly (the editor UI does this for test-runs). This unified default keeps every caller — API, MCP, CLI, CI, schedules and the dashboard — coherent on every selector. The run object's `version_ref` states which definition executed. Ignored for system agents.",
        },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                input: {
                  type: "object",
                  description:
                    "Run input values, validated against the agent's input schema. File fields " +
                    "take `upload://upl_xxx` references (from `createUpload`), " +
                    "`document://doc_xxx` references (an existing document the caller can read), " +
                    "or inline `data:<mime>;name=<filename>;base64,<payload>` URIs (≤4 MiB decoded).",
                },
                rerun_from: {
                  type: "string",
                  description:
                    "Run id whose persisted `input` to replay on this run. Mutually exclusive with `input` (400 if both are sent). The referenced run must be visible in the caller's org + application scope (404 otherwise; end-users can only replay their own runs) and must belong to the agent being triggered (409 `rerun_agent_mismatch`). Staged `upload://` inputs are materialized on the original run and rewritten in its persisted input as durable `document://` references, so later reruns reuse the same documents without depending on upload retention. Existing `document://` inputs remain unchanged. **Limitation:** inline `data:` inputs are NOT replayable — their bytes are materialized into the original run's workspace and stripped from the stored input (only a payload-less marker is persisted), so replaying a run whose input carried an inline file returns 409 `rerun_inline_input_unavailable`. Stage the file with `createUpload` when the input must be replayable.",
                },
                modelId: {
                  type: "string",
                  description:
                    "Model ID override for this run — a system model key or an org-model UUID. Pins THIS run to that model, taking priority over the full resolution cascade (request `modelId` > agent model setting > org default model > system default). Without it, the org default is resolved at run creation — not ahead of time — so changing the org default between triggers silently changes the model used by subsequent runs. Returns 404 when the referenced model does not exist. The response echoes the resolved `model_label` + `model_source` so callers can verify which model the run actually uses.",
                },
                proxyId: {
                  type: "string",
                  description:
                    'Proxy ID override for this run, or "none" to disable proxying. Takes priority over agent and org defaults.',
                },
                config: {
                  type: "object",
                  additionalProperties: true,
                  description:
                    "Per-run config override. Deep-merged with the per-application persisted config (`application_packages.config`): override leaves replace, plain-object children merge recursively, arrays are replaced wholesale, `null` at a leaf sets the value to null (validated as missing for required string fields), missing keys fall through. Re-validated against the manifest config schema after the merge — a 400 `invalid_config` is returned if the merged result violates the schema. Top-level `null` is rejected (returns 400) — omit the field to inherit persisted defaults, send `{}` for an explicit empty override. Mirrors the OpenAPI Assistants `runs.create { instructions, model, tools }` and Argo Workflows `submitOptions.parameters` SOTA — every client (UI, CLI, SDK) reaches the same resolved config for the same `(persisted, override)` pair.",
                },
                connection_overrides: {
                  type: "object",
                  description:
                    'Per-integration connection picks for THIS run (flat-connections mechanism #2). Flat map: `{ "@scope/integration": "<connection_id>" }` — one connection per integration; the chosen connection carries its own authKey. Loses to admin pins (mechanism #1), beats the schedule-frozen layer (#3) and the actor-fallback (#4). Resolved at kickoff, persisted on `runs.connection_overrides` and snapshotted into `runs.resolved_connections` so the spawn loader + MITM credentials refresh honour the same pick. Returns 412 `missing_integration_connection` if the chosen id is not accessible to the actor.',
                  additionalProperties: { type: "string" },
                },
                dependency_overrides: {
                  type: "object",
                  description:
                    'Per-run dependency version overrides (#666). Flat map: `{ "@scope/skill": "draft" | "<semver|dist-tag>" }`. By default every skill in the agent\'s closure resolves against PUBLISHED versions honoring its manifest pin; an entry here overrides that for a single run — `"draft"` pulls the dependency\'s mutable working copy (the skill edit loop: edit → run → observe, no republish), any other value replaces the pin with that spec. Run-scoped only (never stored in the manifest) and recorded on the run object so a run that consumed draft bytes is never mistaken for a reproducible one. An unsatisfiable pin (including a never-published dependency) returns 422 `dependency_unresolved` before the run starts — pass an override or publish the dependency to fix it.',
                  additionalProperties: { type: "string" },
                },
              },
            },
            example: {
              input: { message: "Summarize my latest emails" },
              config: { dryRun: true },
              dependency_overrides: { "@test/test-skill": "draft" },
            },
          },
        },
      },
      responses: {
        "201": {
          description:
            "Run created (fire-and-forget — execution continues asynchronously). The body is the created run resource, same shape as `GET /runs/{id}`: resolved `model_label` / `model_source` (detect org-default drift at trigger time per #635), `status`, `version_ref`, `agent_scope`, etc., so no follow-up GET is needed.",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Run" },
              example: {
                id: "run_cm1abc123def456",
                packageId: "@acme/email-sorter",
                userId: "usr_k7x9m2p4q1",
                endUserId: null,
                apiKeyId: null,
                orgId: "org_r3t5w8y1z6",
                applicationId: "app_m4n5o6p7",
                scheduleId: null,
                status: "pending",
                input: { message: "Summarize my latest emails" },
                result: null,
                checkpoint: {},
                error: null,
                metadata: null,
                config: { dryRun: true },
                config_override: { dryRun: true },
                started_at: "2026-01-15T10:30:00Z",
                completed_at: null,
                duration: null,
                cost: null,
                unread: false,
                runNumber: 17,
                token_usage: null,
                version_label: "1.2.0",
                version_ref: "1.2.0",
                proxy_label: null,
                model_label: "Claude Sonnet 4",
                model_source: "org",
                runner_name: null,
                runner_kind: null,
                agent_scope: "@acme",
                agent_name: "email-sorter",
                runOrigin: "platform",
                contextSnapshot: null,
                modelCredentialId: "mpc_8h2k4m6n",
                connection_overrides: null,
                dependency_overrides: null,
                user_name: null,
                end_user_name: null,
                api_key_name: null,
                schedule_name: null,
                connections_used: null,
                package_ephemeral: false,
                document_counts: { input: 0, output: 0 },
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "Concurrent request with the same Idempotency-Key still in flight, the `rerun_from` run belongs to a different agent (`rerun_agent_mismatch`), or the `rerun_from` run's input carried an inline `data:` file whose bytes were materialized and are not replayable (`rerun_inline_input_unavailable` — re-send the file in `input`, preferably as an `upload://` reference)",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "410": {
          description:
            "A referenced upload has expired before consume, or its post-consume reuse window has elapsed (`upload_expired`) — stage a fresh upload and retry",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "412": {
          description: "Missing integration connection (`missing_integration_connection`)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "422": {
          description:
            "Same Idempotency-Key used with a different request body (`idempotency_conflict`), or the versioned bundle cannot be assembled from stored artifacts: a dependency pin resolves to no published version (`dependency_unresolved`), the stored archive or manifest is malformed or exceeds limits (`bundle_invalid`), or the bundle fails the signature policy (`bundle_signature_invalid`)",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": {
          description:
            "Unexpected server error (`internal_error`), or the stored bundle's bytes no longer match their recorded integrity hash (`bundle_integrity_mismatch`) — corruption or tampering at rest; retrying will not help, republish the version or contact the operator",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
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
            Link: { $ref: "#/components/headers/Link" },
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
        // requireAgent() 404s when the agent is not visible in the caller's
        // org+application scope; the org/app-context middleware 403s on an
        // org/app mismatch (org-context.ts / app-context.ts). Both are
        // reachable on this app-scoped read.
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteAgentRuns",
      tags: ["Runs"],
      summary: "Delete all runs for an agent",
      description:
        "Delete all completed runs for an agent. Bulk mutation — returns a documented operation result ({ deleted_count }), not a 204 (issue #657).",
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
                required: ["deleted_count"],
                properties: {
                  deleted_count: {
                    type: "integer",
                    description: "Number of runs deleted",
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        // requireAgent() 404s when the agent is not visible in the caller's
        // org+application scope (guards.ts:requireAgent → agent_not_found).
        "404": { $ref: "#/components/responses/NotFound" },
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
        "Run an agent defined entirely in the request body. The platform creates a shadow `packages` row (ephemeral = true), runs it through the standard pipeline, and returns `201` + the created run resource (same shape as `GET /runs/{id}`; the shadow package id is the resource's `packageId`). Stream progress via `GET /api/realtime/runs/{id}`. See `docs/specs/INLINE_RUNS.md`.",
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
                  description:
                    "Run input validated against manifest.input.schema (AJV). File fields take " +
                    "`upload://upl_xxx` references (from `createUpload`), `document://doc_xxx` " +
                    "references, or inline `data:<mime>;name=<filename>;base64,<payload>` URIs " +
                    "(≤4 MiB decoded) — same contract as `POST /agents/{scope}/{name}/run`.",
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
        "201": {
          description:
            "Inline run created — stream via SSE. The body is the created run resource (same shape as `GET /runs/{id}`).",
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
                $ref: "#/components/schemas/Run",
                description:
                  "The created run resource — same shape as `GET /runs/{id}`. `packageId` is the shadow package id (reserved `@inline/r-<uuid>` scope, hidden from catalog queries).",
              },
              example: {
                id: "run_cm1abc123",
                packageId: "@inline/r-abc12345-6789-4cde-8f01-23456789abcd",
                userId: "usr_k7x9m2p4q1",
                endUserId: null,
                apiKeyId: null,
                orgId: "org_r3t5w8y1z6",
                applicationId: "app_m4n5o6p7",
                scheduleId: null,
                status: "pending",
                input: { docId: "doc_123" },
                result: null,
                checkpoint: {},
                error: null,
                metadata: null,
                config: null,
                config_override: null,
                started_at: "2026-01-15T10:30:00Z",
                completed_at: null,
                duration: null,
                cost: null,
                unread: false,
                runNumber: 1,
                token_usage: null,
                version_label: null,
                version_ref: "draft",
                proxy_label: null,
                model_label: "Claude Sonnet 4",
                model_source: "org",
                runner_name: null,
                runner_kind: null,
                agent_scope: "@inline",
                agent_name: "one-shot",
                runOrigin: "platform",
                contextSnapshot: null,
                modelCredentialId: "mpc_8h2k4m6n",
                connection_overrides: null,
                dependency_overrides: null,
                user_name: null,
                end_user_name: null,
                api_key_name: null,
                schedule_name: null,
                connections_used: null,
                package_ephemeral: true,
                document_counts: { input: 0, output: 0 },
                inline_manifest: {
                  $schema: "https://schemas.afps.dev/v0/agent.schema.json",
                  name: "@inline/one-shot",
                  display_name: "One-shot summary",
                  version: "0.0.0",
                  type: "agent",
                  schema_version: "0.1",
                  dependencies: {},
                },
                inline_prompt: "Summarize the attached document in three bullet points.",
              },
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
        "422": {
          description:
            "Same Idempotency-Key used with a different request body (`idempotency_conflict`), or a pinned dependency's bundle cannot be assembled from stored artifacts: a dependency pin resolves to no published version (`dependency_unresolved`), the stored archive or manifest is malformed or exceeds limits (`bundle_invalid`), or the bundle fails the signature policy (`bundle_signature_invalid`)",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": {
          description:
            "Unexpected server error (`internal_error`), or a stored bundle's bytes no longer match their recorded integrity hash (`bundle_integrity_mismatch`) — corruption or tampering at rest; retrying will not help, republish the version or contact the operator",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/runs/inline/validate": {
    post: {
      operationId: "validateInlineRun",
      tags: ["Runs"],
      summary: "Validate an inline manifest without firing a run",
      description:
        "Dry-run validator. Runs the same preflight as `POST /api/runs/inline` — manifest shape, config + input against manifest schemas, and integration readiness — but never inserts a shadow package, never fires the pipeline, and never consumes run credits. Returns `200 { valid: true }` on success, `400` problem+json (with the accumulated validation errors) otherwise. Lets developers iterate on a manifest without leaving run history behind.\n\n**Rate limit:** shares the same per-user bucket as `POST /api/runs/inline` (`INLINE_RUN_LIMITS.rate_per_min`). Iterative validation calls count against the same quota as actual runs — tight loops can trigger `429`.",
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
                required: ["valid"],
                properties: {
                  valid: {
                    type: "boolean",
                    enum: [true],
                    description:
                      "Always `true` on 200 — validation failures are reported as `400` problem+json with the accumulated error list.",
                  },
                },
              },
              example: { valid: true },
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
        "403": { $ref: "#/components/responses/Forbidden" },
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
        { name: "start_date", in: "query", schema: { type: "string", format: "date-time" } },
        { name: "end_date", in: "query", schema: { type: "string", format: "date-time" } },
      ],
      responses: {
        "200": {
          description: "Paginated run list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            Link: { $ref: "#/components/headers/Link" },
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
      summary: "Get run status/result (optionally long-poll until terminal)",
      description:
        "Get run details including status, result, input, and duration.\n\nPass `?wait=<seconds>` (or `?wait=true` for the maximum) to long-poll: the server holds the request until the run reaches a terminal status (`success`, `failed`, `timeout`, `cancelled`) or the wait elapses, then returns the current run object exactly as the plain call does. The wait is capped at **55 seconds** — deliberately below the 60 s idle timeouts that ship as defaults in common reverse proxies (nginx `proxy_read_timeout`, ALB idle timeout) so the long poll always completes with a real response instead of a proxy 504; values above the cap are clamped. A response with a non-terminal `status` simply means the wait timed out — issue the same call again to keep waiting. One long poll replaces N sleep+getRun round-trips, which is the recommended completion-wait pattern for MCP clients (the SSE stream is not reachable through the MCP server).\n\n**Concurrency bound:** each identity (user or API key) may hold at most **10** concurrent waits across all runs. Beyond the cap the request degrades to the immediate no-wait response (`wait` is ignored) — a non-terminal `status` means poll again, and capacity self-heals as earlier waits resolve.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "wait",
          in: "query",
          required: false,
          schema: {
            oneOf: [
              { type: "boolean", description: "`true` waits the maximum 55 s; `false` disables." },
              {
                type: "integer",
                minimum: 0,
                description: "Wait budget in seconds. Values above 55 are clamped to 55.",
              },
            ],
          },
          description:
            "Hold the request until the run reaches a terminal status or this many seconds elapse (capped at 55, see operation description), then return the run object. `0`/`false`/absent = return immediately (default). Negative, fractional, or non-numeric values return 400. At most 10 concurrent waits per identity — beyond the cap the request returns immediately as if `wait` were 0 (degrade-to-immediate, see operation description).",
        },
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
                endUserId: null,
                apiKeyId: null,
                orgId: "org_r3t5w8y1z6",
                applicationId: "app_m4n5o6p7",
                scheduleId: "sched_cm1abc456def789",
                status: "success",
                input: { folder: "inbox", maxEmails: 50 },
                result: {
                  output: { processed: 42, labeled: 38 },
                  text: "## Inbox triage\nProcessed 42 emails, labeled 38.",
                },
                checkpoint: { lastProcessedId: "msg_99f2a" },
                error: null,
                metadata: null,
                config: { folder: "inbox" },
                config_override: null,
                started_at: "2026-01-15T10:30:00Z",
                completed_at: "2026-01-15T10:31:12Z",
                duration: 72000,
                cost: 0.0034,
                unread: true,
                runNumber: 17,
                token_usage: {
                  input_tokens: 8200,
                  output_tokens: 4250,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 1024,
                },
                version_label: "1.2.0",
                version_ref: "1.2.0",
                proxy_label: null,
                model_label: "Claude Sonnet 4",
                model_source: "system",
                runner_name: null,
                runner_kind: null,
                agent_scope: "@acme",
                agent_name: "email-sorter",
                runOrigin: "platform",
                contextSnapshot: null,
                modelCredentialId: null,
                connection_overrides: null,
                dependency_overrides: null,
                user_name: "Pierre",
                end_user_name: null,
                api_key_name: null,
                schedule_name: "Weekday morning sort",
                connections_used: null,
                package_ephemeral: false,
                document_counts: { input: 0, output: 0 },
              },
            },
          },
        },
        "400": {
          description:
            "Invalid `wait` parameter (negative, fractional, or non-numeric value — see the `wait` parameter description)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Bad Request",
                status: 400,
                detail:
                  "Invalid 'wait' value: expected true, false, or a non-negative integer number of seconds (max 55)",
                code: "invalid_request",
                requestId: "req_abc123",
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
        'Get persisted log entries for a run, wrapped in the standard list envelope `{ object: "list", data, hasMore }`. Pass `?since=<id>` to receive only entries with `id > since` — the cursor used by the CLI\'s polling tail to bound per-poll payload growth, and the pagination cursor when combined with `?limit=`. Pass `?level=` to filter by minimum severity (`level=info` skips debug breadcrumbs). `limit` defaults to 1000 when omitted — the response is never unbounded; when more entries follow, `hasMore` is `true` and an RFC 5988 `Link: <…?since=<lastId>>; rel="next"` response header points at the next page. `id` is a monotonic BIGSERIAL; invalid `since`/`level`/`limit` values fall back to the default rather than 400 so a stale cursor never breaks a polling tail. Rate-limited to 120/min per identity. Note: tool-result payloads inside `data` are truncated at write time by the runner (default 2048 bytes, operator-tunable via `TOOL_RESULT_BYTE_LIMIT`) — entries already persisted truncated cannot be recovered by this endpoint.',
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
            'Return only log entries with `id > since`. Used by the CLI\'s `appstrate run` remote polling loop to fetch incremental tails without re-shipping the full history each poll, and as the cursor in the `Link; rel="next"` pagination header.',
        },
        {
          name: "level",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["debug", "info", "warn", "error"] },
          description:
            "Minimum severity to include (`debug < info < warn < error`). `level=info` returns info, warn and error entries. Defaults to `debug` (everything).",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 1000, default: 1000 },
          description:
            'Maximum number of entries to return. Defaults to 1000 when omitted. When more entries follow, the response carries a `Link; rel="next"` header whose URL re-uses `since` as the cursor — page with it to read longer histories.',
        },
      ],
      responses: {
        "200": {
          description: "Log entries (list envelope)",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            Link: { $ref: "#/components/headers/Link" },
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/RunLog" },
                  },
                  hasMore: {
                    type: "boolean",
                    description:
                      'True when more entries follow the current page (the server caps each page at `limit`, default 1000) — the `Link; rel="next"` header carries the next page\'s URL.',
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/runs/{id}/cancel": {
    post: {
      operationId: "cancelRun",
      tags: ["Runs"],
      summary: "Cancel a run",
      description:
        "Cancel a running or pending run. Returns the updated run resource — same shape as `GET /runs/{id}` — read after the terminal pipeline ran, so `status` is `cancelled` and cost/duration reflect the final state.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Run cancelled — the body is the updated run resource (`status: cancelled`)",
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
                endUserId: null,
                apiKeyId: null,
                orgId: "org_r3t5w8y1z6",
                applicationId: "app_m4n5o6p7",
                scheduleId: null,
                status: "cancelled",
                input: { folder: "inbox", maxEmails: 50 },
                result: null,
                checkpoint: {},
                error: "Cancelled by user",
                metadata: null,
                config: null,
                config_override: null,
                started_at: "2026-01-15T10:30:00Z",
                completed_at: "2026-01-15T10:30:45Z",
                duration: 45000,
                cost: 0.0012,
                unread: false,
                runNumber: 18,
                token_usage: null,
                version_label: "1.2.0",
                version_ref: "1.2.0",
                proxy_label: null,
                model_label: "Claude Sonnet 4",
                model_source: "org",
                runner_name: null,
                runner_kind: null,
                agent_scope: "@acme",
                agent_name: "email-sorter",
                runOrigin: "platform",
                contextSnapshot: null,
                modelCredentialId: null,
                connection_overrides: null,
                dependency_overrides: null,
                user_name: "Pierre",
                end_user_name: null,
                api_key_name: null,
                schedule_name: null,
                connections_used: null,
                package_ephemeral: false,
                document_counts: { input: 0, output: 0 },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
                input: {
                  type: "object",
                  description:
                    "Run input, validated against the agent's input schema. File fields (`format: uri` + `contentMediaType`) accept ONLY inline `data:<mime>;name=<file>;base64,<payload>` URIs on remote runs — `upload://` and `document://` references are rejected (400), because the run executes on the caller's host, whose workspace the platform never provisions.",
                },
                dependency_overrides: {
                  type: "object",
                  description:
                    'Per-run dependency version overrides (#666/#686). Flat map `{ "@scope/dep": "draft" | "<semver|dist-tag>" }`; keys may name a declared skill OR integration. `"draft"` opts that dependency into its working copy; any other value replaces the manifest pin. An unsatisfiable pin aborts the run with `dependency_unresolved` (422).',
                  additionalProperties: { type: "string" },
                },
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
                description:
                  "Operation envelope (not the run resource): the one-time sink credentials plus the created run's `id`. Fetch the resource itself via `GET /runs/{id}`.",
                required: ["id", "url", "finalize_url", "secret", "expiresAt"],
                properties: {
                  id: { type: "string", description: "The created run's id." },
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
                "AFPS runtime `RunResult` — `memories`, `pinned`, `output`, `logs` plus optional terminal `status`/`error`/`durationMs` and authoritative `usage`/`cost`. Older runners may also send the deprecated markdown `report` aggregate.",
              properties: {
                memories: { type: "array" },
                pinned: { type: "object" },
                output: {},
                logs: { type: "array" },
                report: {
                  type: "string",
                  deprecated: true,
                  description:
                    "Deprecated report-tool markdown aggregate. New agents publish markdown documents.",
                },
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
    post: {
      operationId: "publishRunDocument",
      tags: ["Runs"],
      summary: "Publish an agent-produced document (HMAC, streaming)",
      description:
        "Posted by the agent runtime — via the `publish_document` runtime tool or the end-of-run `outputs/` sweep — to store a file the agent produced as a durable `agent_output` document attached to the run. The raw file bytes are the request body (streamed straight to storage, up to `DOCUMENT_MAX_FILE_BYTES`, 100 MiB by default); metadata is carried in the `X-Document-Name` and `Content-Type` headers. Same Standard Webhooks HMAC auth as the other run routes, verified over an EMPTY body (the bytes stream unbuffered; integrity is the returned sha256). Enforced synchronously: the per-file cap and per-run output budget cut the stream mid-flight (413, deleting any partial object); the org storage quota returns 403. Idempotent for sweep retries: an identical (run, sha256, name) upload returns the existing document with 200 instead of storing it twice. Requires the run to be `running` (409 otherwise).",
      parameters: [
        { name: "runId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "X-Document-Name",
          in: "header",
          required: true,
          schema: { type: "string" },
          description: "Display name for the document (sanitised server-side).",
        },
        {
          name: "Content-Type",
          in: "header",
          required: true,
          schema: { type: "string" },
          description: "MIME type of the document bytes.",
        },
        { name: "webhook-id", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-timestamp", in: "header", required: true, schema: { type: "string" } },
        { name: "webhook-signature", in: "header", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        },
      },
      security: [],
      responses: {
        "201": {
          description: "Document stored",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "uri", "name", "mime", "size", "sha256"],
                properties: {
                  id: { type: "string" },
                  uri: { type: "string", description: "`document://<id>` durable URI." },
                  name: { type: "string" },
                  mime: { type: "string" },
                  size: { type: "integer" },
                  sha256: { type: "string" },
                },
              },
            },
          },
        },
        "200": {
          description:
            "Idempotent replay — an identical (run, sha256, name) document already existed; the existing document is returned.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "uri", "name", "mime", "size", "sha256"],
                properties: {
                  id: { type: "string" },
                  uri: { type: "string" },
                  name: { type: "string" },
                  mime: { type: "string" },
                  size: { type: "integer" },
                  sha256: { type: "string" },
                },
              },
            },
          },
        },
        "400": { description: "X-Document-Name or Content-Type header missing / empty body" },
        "401": { description: "Signature verification failed" },
        "403": { description: "storage_limit_exceeded" },
        "404": { description: "run_not_found" },
        "409": { description: "run_not_running" },
        "410": { description: "run_sink_closed | run_sink_expired" },
        "413": { description: "Document exceeds the per-file or per-run output limit" },
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
                description:
                  "Operation result (not the run resource): `sink_expires_at` is internal sink state, deliberately not part of the public Run shape.",
                required: ["id", "expiresAt"],
                properties: {
                  id: { type: "string", description: "The run's id." },
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
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
} as const;
