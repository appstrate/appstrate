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
} as const;
