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
} as const;
