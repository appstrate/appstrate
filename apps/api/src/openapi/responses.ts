// SPDX-License-Identifier: Apache-2.0

import { REQUEST_ID_ONLY_HEADERS } from "./headers.ts";

/**
 * Reusable OpenAPI response definitions — RFC 9457 Problem Details format.
 */
export const responses = {
  Unauthorized: {
    description: "Missing or invalid authentication",
    headers: {
      "WWW-Authenticate": { $ref: "#/components/headers/WWWAuthenticate" },
    },
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
    description:
      'Validation error. Body-level failures emit `code: "validation_failed"` ' +
      "with a populated `errors[]` array listing every offending field in one " +
      "response. Single-field failures outside the body (query params, headers) " +
      'still use `code: "invalid_request"` with the `param` pointer.',
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        examples: {
          aggregated: {
            summary: "Multiple body fields failed validation",
            value: {
              type: "https://docs.appstrate.dev/errors/validation-failed",
              title: "Validation Failed",
              status: 400,
              detail: "name: Required (+2 more)",
              code: "validation_failed",
              requestId: "req_abc123",
              errors: [
                { field: "name", code: "invalid_type", message: "Required" },
                { field: "email", code: "invalid_format", message: "Invalid email" },
                { field: "age", code: "invalid_type", message: "Expected number" },
              ],
            },
          },
          singleField: {
            summary: "Single non-body field failed validation",
            value: {
              type: "https://docs.appstrate.dev/errors/invalid-request",
              title: "Invalid Request",
              status: 400,
              detail: "Field is required",
              code: "invalid_request",
              param: "limit",
              requestId: "req_abc123",
            },
          },
        },
      },
    },
  },
  UnsupportedMediaType: {
    description: "The endpoint requires a different request media type",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/archive-required",
          title: "Archive Required",
          status: 415,
          detail: "MCP-server packages must be uploaded as a multipart .afps or .zip archive.",
          code: "archive_required",
          requestId: "req_abc123",
        },
      },
    },
  },
  RateLimited: {
    description: "Too many requests",
    headers: {
      ...REQUEST_ID_ONLY_HEADERS,
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
    headers: REQUEST_ID_ONLY_HEADERS,
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
  InternalServerError: {
    description: "Unexpected server error",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/internal-error",
          title: "Internal Server Error",
          status: 500,
          detail: "An unexpected error occurred. Please try again or contact support.",
          code: "internal_error",
          requestId: "req_abc123",
        },
      },
    },
  },
  /**
   * A STORED package artifact could not be expanded within the platform's
   * decompression ceiling. Shared by the package file-explorer operations,
   * which all read the caller's own package and share one remedy (republish).
   *
   * `POST .../fork` deliberately does NOT `$ref` this: its 422 carries two
   * facts true only on that boundary — nothing was written, and the source
   * belongs to another organization so the caller cannot republish it.
   */
  PackageArchiveUnreadable: {
    description:
      "The stored artifact expands past the package decompression ceiling and was refused " +
      "(`package_archive_unreadable`). This is the SAME ceiling the import gate applies, so " +
      "reaching it means the archive is a bomb or was stored before the gate covered this path " +
      "— republish the package. RFC 9457 problem+json.",
    headers: REQUEST_ID_ONLY_HEADERS,
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/package-archive-unreadable",
          title: "Package Archive Unreadable",
          status: 422,
          detail:
            "The package archive expands past the 50 MB decompression limit and was refused (decompressed-budget-exceeded). Republish the package from bytes that fit the limit.",
          code: "package_archive_unreadable",
          requestId: "req_abc123",
        },
      },
    },
  },
  /**
   * The 404 BOTH schedule writes answer when the target agent has no published
   * version — shared rather than restated, because both routes resolve the
   * manifest the schedule will FIRE (`assertScheduleTargetValid`) and both
   * therefore refuse the same agent for the same reason.
   *
   * It was written out inline on `POST` only, so `PUT` declared the generic
   * `NotFound` while returning this — and the test that was supposed to catch
   * that read the create operation alone and reported green. One component,
   * `$ref`'d twice, is what makes the two operations unable to drift.
   */
  NoPublishedVersion: {
    description:
      "Agent not found, or the agent has no published version (`no_published_version`). A " +
      "schedule with no `version_override` fires the PUBLISHED manifest, so a never-published " +
      "agent is refused at the write rather than 404ing on every tick; pin the working copy " +
      'with `version_override: "draft"` to schedule it anyway.',
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Agent '@acme/reporter' has no published version",
          code: "no_published_version",
          requestId: "req_abc123",
        },
      },
    },
  },
  IdempotencyConflict: {
    description: "Same Idempotency-Key used with a different request body",
    headers: REQUEST_ID_ONLY_HEADERS,
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
