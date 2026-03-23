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
  Sunset: {
    description:
      "RFC 8594 Sunset header. Present when the requested API version is deprecated, indicating when it will be removed.",
    schema: { type: "string", format: "date" },
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
  XRateLimitRemaining: {
    description: "Legacy header: remaining requests in the current window.",
    schema: { type: "integer" },
  },
  XRateLimitReset: {
    description: "Legacy header: seconds until the rate limit window resets.",
    schema: { type: "integer" },
  },
} as const;
