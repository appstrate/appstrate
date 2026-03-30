/**
 * Reusable OpenAPI response definitions — RFC 9457 Problem Details format.
 */
export const responses = {
  Unauthorized: {
    description: "Missing or invalid authentication",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/unauthorized",
          title: "Unauthorized",
          status: 401,
          detail: "Invalid or missing session",
          code: "unauthorized",
          requestId: "req_abc123",
        },
      },
    },
  },
  Forbidden: {
    description: "Insufficient permissions",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Insufficient permissions",
          code: "forbidden",
          requestId: "req_abc123",
        },
      },
    },
  },
  NotFound: {
    description: "Resource not found",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Resource not found",
          code: "not_found",
          requestId: "req_abc123",
        },
      },
    },
  },
  ValidationError: {
    description: "Validation error",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/invalid-request",
          title: "Invalid Request",
          status: 400,
          detail: "Field is required",
          code: "invalid_request",
          requestId: "req_abc123",
        },
      },
    },
  },
  RateLimited: {
    description: "Too many requests",
    headers: {
      "Request-Id": { $ref: "#/components/headers/RequestId" },
      "Retry-After": { $ref: "#/components/headers/RetryAfter" },
      RateLimit: { $ref: "#/components/headers/RateLimit" },
      "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
    },
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/rate-limited",
          title: "Rate Limited",
          status: 429,
          detail: "Too many requests. Please try again shortly.",
          code: "rate_limited",
          requestId: "req_abc123",
          retryAfter: 30,
        },
      },
    },
  },
  IdempotencyInProgress: {
    description: "A request with the same Idempotency-Key is already being processed",
    headers: {
      "Request-Id": { $ref: "#/components/headers/RequestId" },
    },
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/idempotency-in-progress",
          title: "Idempotency In Progress",
          status: 409,
          detail:
            "A request with the same Idempotency-Key is already being processed. Please wait and retry.",
          code: "idempotency_in_progress",
          requestId: "req_abc123",
        },
      },
    },
  },
  IdempotencyConflict: {
    description: "Same Idempotency-Key used with a different request body",
    headers: {
      "Request-Id": { $ref: "#/components/headers/RequestId" },
    },
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/idempotency-conflict",
          title: "Idempotency Conflict",
          status: 422,
          detail:
            "This Idempotency-Key was already used with a different request body. Use a new key for different requests.",
          code: "idempotency_conflict",
          requestId: "req_abc123",
        },
      },
    },
  },
} as const;
