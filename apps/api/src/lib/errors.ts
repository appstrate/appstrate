// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 9457 — Problem Details for HTTP APIs.
 *
 * All API errors use `application/problem+json` with standard fields
 * (type, title, status, detail, instance) plus Stripe-like extensions
 * (code, param, requestId, retryAfter, errors[]).
 *
 * @see https://www.rfc-editor.org/rfc/rfc9457
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId: string;
  param?: string;
  retryAfter?: number;
  errors?: ValidationFieldError[];
}

export interface ValidationFieldError {
  field: string;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Base error class
// ---------------------------------------------------------------------------

const DOCS_BASE = "https://docs.appstrate.dev/errors";

function codeToType(code: string): string {
  return `${DOCS_BASE}/${code.replace(/_/g, "-")}`;
}

/**
 * Throwable API error that serialises to RFC 9457 Problem Details.
 * Middleware catches it and sends the response automatically.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly param?: string;
  readonly retryAfter?: number;
  readonly fieldErrors?: ValidationFieldError[];
  readonly headers?: Record<string, string>;

  constructor(opts: {
    status: number;
    code: string;
    title: string;
    detail: string;
    param?: string;
    retryAfter?: number;
    errors?: ValidationFieldError[];
    headers?: Record<string, string>;
  }) {
    super(opts.detail);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.title = opts.title;
    this.param = opts.param;
    this.retryAfter = opts.retryAfter;
    this.fieldErrors = opts.errors;
    this.headers = opts.headers;
  }

  /** Serialise to RFC 9457 Problem Details body. */
  toProblemDetail(requestId: string): ProblemDetail {
    const body: ProblemDetail = {
      type: codeToType(this.code),
      title: this.title,
      status: this.status,
      detail: this.message,
      instance: `urn:appstrate:request:${requestId}`,
      code: this.code,
      requestId,
    };
    if (this.param !== undefined) body.param = this.param;
    if (this.retryAfter !== undefined) body.retryAfter = this.retryAfter;
    if (this.fieldErrors?.length) body.errors = this.fieldErrors;
    return body;
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function invalidRequest(detail: string, param?: string): ApiError {
  return new ApiError({
    status: 400,
    code: "invalid_request",
    title: "Invalid Request",
    detail,
    param,
  });
}

/**
 * Aggregate multiple validation errors into a single 400 response.
 * Sets `code: "validation_failed"` and populates the RFC 9457 `errors[]` array,
 * so clients can surface every problem in one round-trip. `detail` defaults to
 * a human-readable summary derived from the first entry plus a count.
 */
export function validationFailed(errors: ValidationFieldError[], detail?: string): ApiError {
  const summary =
    detail ??
    (errors.length === 0
      ? "Validation failed"
      : errors.length === 1
        ? `${errors[0]!.field}: ${errors[0]!.message}`
        : `${errors[0]!.field}: ${errors[0]!.message} (+${errors.length - 1} more)`);
  return new ApiError({
    status: 400,
    code: "validation_failed",
    title: "Validation Failed",
    detail: summary,
    errors,
  });
}

export function unauthorized(detail: string): ApiError {
  return new ApiError({
    status: 401,
    code: "unauthorized",
    title: "Unauthorized",
    detail,
  });
}

export function forbidden(detail: string): ApiError {
  return new ApiError({
    status: 403,
    code: "forbidden",
    title: "Forbidden",
    detail,
  });
}

export function notFound(detail: string): ApiError {
  return new ApiError({
    status: 404,
    code: "not_found",
    title: "Not Found",
    detail,
  });
}

export function conflict(code: string, detail: string): ApiError {
  return new ApiError({
    status: 409,
    code,
    title: "Conflict",
    detail,
  });
}

export function gone(code: string, detail: string): ApiError {
  return new ApiError({
    status: 410,
    code,
    title: "Gone",
    detail,
  });
}

export function internalError(): ApiError {
  return new ApiError({
    status: 500,
    code: "internal_error",
    title: "Internal Error",
    detail: "An internal error occurred",
  });
}

export function systemEntityForbidden(type: string, id: string, verb = "modify"): ApiError {
  return new ApiError({
    status: 403,
    code: "operation_not_allowed",
    title: "Forbidden",
    detail: `Cannot ${verb} built-in ${type} '${id}'`,
  });
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

import type { z } from "zod";

/** Convert Zod issues to the RFC 9457 `errors[]` entries we expose to clients. */
export function zodIssuesToFieldErrors(
  issues: readonly z.core.$ZodIssue[],
  pathPrefix?: string,
): ValidationFieldError[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    const field = pathPrefix ? (path ? `${pathPrefix}.${path}` : pathPrefix) : path;
    return { field, code: issue.code, message: issue.message };
  });
}

/**
 * Parse a request body with a Zod schema. On failure throws a 400 with every
 * issue populated in `errors[]` so clients receive all problems in one call.
 * The optional `param` is used as a path prefix for nested schema context.
 */
export function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
  param?: string,
): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed(zodIssuesToFieldErrors(parsed.error.issues, param));
  }
  return parsed.data;
}
