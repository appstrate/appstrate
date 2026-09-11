// SPDX-License-Identifier: Apache-2.0

/**
 * Reusable OpenAPI response header definitions.
 */
export const headers = {
  RequestId: {
    description: "Unique request identifier (req_ prefix). Included on every response for tracing.",
    schema: { type: "string", example: "req_abc123def456" },
  },
  AppstrateVersion: {
    description:
      "API version used for this request (format: YYYY-MM-DD). Always included on authenticated responses.",
    schema: { type: "string", example: "2026-03-21" },
  },
  IdempotentReplayed: {
    description:
      "Set to 'true' when the response is a cached replay of a previous idempotent request.",
    schema: { type: "string", enum: ["true"] },
  },
  RateLimit: {
    description:
      "IETF RateLimit structured header (limit=N, remaining=M, reset=S). Present on rate-limited endpoints.",
    schema: { type: "string", example: "limit=20, remaining=19, reset=58" },
  },
  RateLimitPolicy: {
    description: "IETF RateLimit-Policy header describing the rate limit window (e.g. 20;w=60).",
    schema: { type: "string", example: "20;w=60" },
  },
  RetryAfter: {
    description: "Seconds to wait before retrying. Present on 429 responses.",
    schema: { type: "integer" },
  },
  WWWAuthenticate: {
    description:
      'RFC 6750 Bearer challenge, present on every 401. `Bearer error="invalid_token"` ' +
      "when a credential was presented but rejected, bare `Bearer` when no credential was " +
      "presented. Resources registered for RFC 9728 discovery (e.g. MCP) answer with a " +
      'richer challenge carrying `resource_metadata="…"`.',
    schema: { type: "string", example: 'Bearer error="invalid_token"' },
  },
  Link: {
    description:
      'RFC 5988 pagination link(s), e.g. `<https://…?since=42&limit=100>; rel="next"`. Present only when another page follows — absence means the listing is complete.',
    schema: {
      type: "string",
      example: '<https://example.com/api/runs/run_x/logs?since=42&limit=100>; rel="next"',
    },
  },
} as const;

/**
 * The response-header set every ordinary API response carries: the tracing id
 * and the resolved API version. Referenced rather than re-spelled at each of
 * the ~100 responses that declare it, so the pair cannot drift apart in one
 * corner of the spec. Sites that carry extra headers (`Link`,
 * `Idempotent-Replayed`, `RateLimit`…) spread this first and append their own,
 * which keeps the emitted key order identical to the inline form.
 */
export const STD_RESPONSE_HEADERS = {
  "Request-Id": { $ref: "#/components/headers/RequestId" },
  "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
} as const;

/**
 * Tracing id alone — the set declared by the responses that document no version
 * header, in practice the `204 No Content` bodies plus a scattering of 4xx
 * errors. Kept as its own const rather than folded into `STD_RESPONSE_HEADERS`
 * so this pass stays a pure deduplication: whether those responses *should*
 * also advertise `Appstrate-Version` is a spec change, and a spec change is a
 * baseline diff.
 */
export const REQUEST_ID_ONLY_HEADERS = {
  "Request-Id": { $ref: "#/components/headers/RequestId" },
} as const;
