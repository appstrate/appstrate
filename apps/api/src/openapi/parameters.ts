// SPDX-License-Identifier: Apache-2.0

/**
 * Reusable OpenAPI parameter definitions.
 */
export const parameters = {
  Offset: {
    name: "offset",
    in: "query" as const,
    required: false,
    description: "Number of items to skip before the first returned item.",
    schema: { type: "integer", minimum: 0, default: 0 },
  },
  XOrgId: {
    name: "X-Org-Id",
    in: "header" as const,
    description:
      "Organization ID. Required for cookie auth. Not needed for API key auth (org resolved from key).",
    schema: { type: "string", format: "uuid" },
  },
  SseOrgId: {
    name: "orgId",
    in: "query" as const,
    required: true,
    description:
      "Organization ID. Required for SSE auth (cookies cannot carry X-Org-Id header on EventSource).",
    schema: { type: "string", format: "uuid" },
  },
  Verbose: {
    name: "verbose",
    in: "query" as const,
    required: false,
    description:
      "When true, include full payload with `result` and `data` fields. Default (false) strips large user-content fields for safer consumption by external agents.",
    schema: { type: "boolean", default: false },
  },
  SseChannels: {
    name: "channels",
    in: "query" as const,
    required: false,
    description:
      "Comma-separated list of SSE channels to subscribe to (`run_update`, `run_log`, `run_metric`, `connection_update`, `chat_session_update`). " +
      "Omit to receive every channel (default, unchanged behaviour). Unknown names are ignored; if nothing is recognised the stream falls back to every channel. " +
      "Declaring only the channels you consume avoids fanning the `run_log` firehose out to a stream that discards it.",
    schema: { type: "string", example: "run_update,connection_update" },
  },
  AppstrateUser: {
    name: "Appstrate-User",
    in: "header" as const,
    required: false,
    description:
      "End-user ID (eu_ prefix) to execute the request on behalf of. API key auth only — rejected with 400 on cookie auth.",
    schema: { type: "string" },
  },
  AppstrateVersion: {
    name: "Appstrate-Version",
    in: "header" as const,
    required: false,
    description:
      "API version override (format: YYYY-MM-DD). Defaults to the org's pinned version or the current platform version.",
    schema: { type: "string" },
  },
  IdempotencyKey: {
    name: "Idempotency-Key",
    in: "header" as const,
    required: false,
    description:
      "Unique key for idempotent requests (max 255 chars). Prevents duplicate resource creation on retries. Cached for 24 hours, " +
      "scoped to the organization and space: a repeat with the same body replays the original response with " +
      "`Idempotent-Replayed: true`, the same key with a different body is `422 idempotency_conflict`, and a concurrent duplicate " +
      "is `409 idempotency_in_progress`. This operation honours the header because it declares this parameter — operations that " +
      "do not declare it refuse the header with `400 idempotency_not_supported` rather than silently ignoring it (see the " +
      "“Idempotency” section of the API description).",
    schema: { type: "string", maxLength: 255 },
  },
  SseSpaceId: {
    name: "spaceId",
    in: "query" as const,
    required: false,
    description:
      "Space ID. Required for cookie auth (SSE cannot send X-Space-Id header). Not needed for API key auth (space resolved from key).",
    schema: { type: "string" },
  },
  SseToken: {
    name: "token",
    in: "query" as const,
    required: false,
    description:
      "API key (ask_ prefix) for SSE authentication. EventSource cannot send Authorization headers, so API key auth uses this query parameter instead.",
    schema: { type: "string" },
  },
  XSpaceId: {
    name: "X-Space-Id",
    in: "header" as const,
    description:
      "Space ID. Required for space-scoped routes (agents, runs, schedules, and space-scoped module routes). Not needed for API key auth (space resolved from key).",
    schema: { type: "string" },
  },
  PackageScope: {
    name: "scope",
    in: "path" as const,
    required: true,
    description: "Package scope (e.g. @myorg)",
    schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
  },
  PackageName: {
    name: "name",
    in: "path" as const,
    required: true,
    description: "Package name",
    schema: { type: "string" },
  },
  PackageActiveFilter: {
    name: "active",
    in: "query" as const,
    required: false,
    description:
      "When `true`, narrows the list to packages installed and enabled in the current " +
      "space — system packages with no install row drop out. Integrations are the one " +
      "exception: they are filtered on effective activation, so an environment-provided " +
      "system integration stays listed even though it has no install row.",
    schema: { type: "string", enum: ["true"] as const },
  },
} as const;
