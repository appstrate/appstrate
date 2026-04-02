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
  SseToken: {
    name: "token",
    in: "query" as const,
    required: false,
    description:
      "API key (ask_ prefix) for SSE authentication. EventSource cannot send Authorization headers, so API key auth uses this query parameter instead.",
    schema: { type: "string" },
  },
} as const;
