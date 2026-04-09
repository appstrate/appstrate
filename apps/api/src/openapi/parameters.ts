// SPDX-License-Identifier: Apache-2.0

/**
 * Reusable OpenAPI parameter definitions.
 */
export const parameters = {
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
      "Unique key for idempotent requests (max 255 chars). Prevents duplicate resource creation on retries. Cached for 24 hours.",
    schema: { type: "string", maxLength: 255 },
  },
  SseAppId: {
    name: "appId",
    in: "query" as const,
    required: false,
    description:
      "Application ID. Required for cookie auth (SSE cannot send X-App-Id header). Not needed for API key auth (app resolved from key).",
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
  XAppId: {
    name: "X-App-Id",
    in: "header" as const,
    description:
      "Application ID. Required for app-scoped routes (agents, runs, schedules, webhooks). Not needed for API key auth (app resolved from key).",
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
} as const;
