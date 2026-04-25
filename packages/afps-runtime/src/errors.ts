// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Unified runtime error taxonomy for `@appstrate/afps-runtime`.
 *
 * The package already ships several typed errors close to where they
 * are raised (`BundleError`, `BundleSignaturePolicyError`,
 * `AfpsEntrypointError`, `RunTimeoutError`). This module sits at the
 * top so consumers can:
 *
 *   - import every typed error from a single subpath
 *     (`@appstrate/afps-runtime/errors`),
 *   - match against the shared {@link AfpsError} marker interface to
 *     decide between domain-known and unexpected errors,
 *   - serialise errors to RFC 9457 problem+json via {@link toProblem}.
 *
 * Existing classes are re-exported here. New classes added in this
 * module fill the gaps in the previous taxonomy: provider URI
 * authorization, generic resolver wiring, run-history fetch errors,
 * runner cancellation, and non-zero workload exits.
 *
 * The base class is structural — `name`, `code`, `message`, optional
 * `details`, optional `cause`. We do not introduce a runtime
 * `instanceof AfpsError` check anywhere because the existing typed
 * errors (BundleError, BundleSignaturePolicyError, …) predate this
 * module and we do not want to break user code that does
 * `instanceof BundleError`. Use {@link isAfpsError} for marker checks.
 */

import { BundleError, type BundleErrorCode } from "./bundle/errors.ts";
import {
  BundleSignaturePolicyError,
  type SignaturePolicyReason,
} from "./bundle/signature-policy.ts";
import { AfpsEntrypointError, type AfpsEntrypointErrorCode } from "./bundle/tool-entrypoint.ts";

/** Stable, machine-readable code for every error class in this module. */
export type AfpsErrorCode =
  | BundleErrorCode
  | SignaturePolicyReason
  | "unsigned_required"
  | AfpsEntrypointErrorCode
  | "RUN_TIMEOUT"
  | "RUN_CANCELLED"
  | "WORKLOAD_EXIT_NONZERO"
  | "PROVIDER_AUTHORIZED_URIS_EMPTY"
  | "PROVIDER_AUTHORIZED_URIS_MISMATCH"
  | "RESOLVER_INVALID_TOOL_SHAPE"
  | "RESOLVER_MISSING_REQUIRED"
  | "RESOLVER_BODY_REFERENCE_FORBIDDEN"
  | "RESOLVER_BODY_TOO_LARGE"
  | "RESOLVER_PATH_OUTSIDE_WORKSPACE"
  | "RESOLVER_PATH_INVALID"
  | "RUN_HISTORY_FETCH_FAILED"
  | "RUN_HISTORY_BAD_RESPONSE"
  | "RUN_HISTORY_TIMEOUT"
  | "CREDENTIAL_RESOLUTION";

/**
 * Marker interface every typed error in this module satisfies. Lets
 * consumers branch on `'code' in err` without a concrete `instanceof`.
 */
export interface AfpsError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown> | undefined;
}

/**
 * Concrete base class for new typed errors introduced in this module.
 * Old classes (`BundleError`, …) keep their own bases so existing
 * `instanceof` checks in user code keep working.
 */
export abstract class AfpsRuntimeError extends Error implements AfpsError {
  abstract readonly code: AfpsErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
    if (details !== undefined) this.details = details;
  }
}

/** Workload did not finish within the configured timeout. */
export class RunTimeoutError extends Error implements AfpsError {
  readonly code = "RUN_TIMEOUT" as const;
  override readonly name = "RunTimeoutError";

  constructor(message: string) {
    super(message);
  }
}

/** The platform asked the runner to abort mid-run. */
export class RunCancelledError extends AfpsRuntimeError {
  override readonly name = "RunCancelledError";
  readonly code = "RUN_CANCELLED" as const;
}

/** Workload exited non-zero without producing a structured output event. */
export class WorkloadExitError extends AfpsRuntimeError {
  override readonly name = "WorkloadExitError";
  readonly code = "WORKLOAD_EXIT_NONZERO" as const;
  readonly exitCode: number;
  readonly adapterName: string;

  constructor(adapterName: string, exitCode: number, lastError?: string) {
    const message = lastError ?? `${adapterName} workload exited with code ${exitCode}`;
    super(message, { adapterName, exitCode, ...(lastError ? { lastError } : {}) });
    this.exitCode = exitCode;
    this.adapterName = adapterName;
  }
}

/** A provider tool tried to call a target outside its allowlist. */
export class ProviderAuthorizationError extends AfpsRuntimeError {
  override readonly name = "ProviderAuthorizationError";
  readonly code: "PROVIDER_AUTHORIZED_URIS_EMPTY" | "PROVIDER_AUTHORIZED_URIS_MISMATCH";

  constructor(
    code: "PROVIDER_AUTHORIZED_URIS_EMPTY" | "PROVIDER_AUTHORIZED_URIS_MISMATCH",
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.code = code;
  }
}

/** Generic resolver wiring failure (bad tool shape, missing entrypoint metadata, etc). */
export class ResolverError extends AfpsRuntimeError {
  override readonly name = "ResolverError";
  readonly code:
    | "RESOLVER_INVALID_TOOL_SHAPE"
    | "RESOLVER_MISSING_REQUIRED"
    | "RESOLVER_BODY_REFERENCE_FORBIDDEN"
    | "RESOLVER_BODY_TOO_LARGE"
    | "RESOLVER_PATH_OUTSIDE_WORKSPACE"
    | "RESOLVER_PATH_INVALID";

  constructor(
    code:
      | "RESOLVER_INVALID_TOOL_SHAPE"
      | "RESOLVER_MISSING_REQUIRED"
      | "RESOLVER_BODY_REFERENCE_FORBIDDEN"
      | "RESOLVER_BODY_TOO_LARGE"
      | "RESOLVER_PATH_OUTSIDE_WORKSPACE"
      | "RESOLVER_PATH_INVALID",
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.code = code;
  }
}

/** A `run_history` sidecar fetch failed (HTTP, JSON, or shape). */
export class RunHistoryError extends AfpsRuntimeError {
  override readonly name = "RunHistoryError";
  readonly code: "RUN_HISTORY_FETCH_FAILED" | "RUN_HISTORY_BAD_RESPONSE" | "RUN_HISTORY_TIMEOUT";

  constructor(
    code: "RUN_HISTORY_FETCH_FAILED" | "RUN_HISTORY_BAD_RESPONSE" | "RUN_HISTORY_TIMEOUT",
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.code = code;
  }
}

/** A credential-resolver could not produce credentials for a provider. */
export class CredentialResolutionError extends AfpsRuntimeError {
  override readonly name = "CredentialResolutionError";
  readonly code = "CREDENTIAL_RESOLUTION" as const;
}

/**
 * Structural marker check — true for every typed error in this module
 * (old + new), false for plain `new Error()`.
 *
 * Useful at API boundaries to decide between "known domain failure
 * → 4xx with code" and "unknown crash → 5xx".
 */
export function isAfpsError(value: unknown): value is AfpsError {
  return (
    value instanceof Error &&
    typeof (value as AfpsError).code === "string" &&
    (value as AfpsError).code.length > 0
  );
}

/**
 * Serialise an error to RFC 9457 problem+json shape. Falls back to a
 * generic 500 envelope for unknown errors so API handlers never leak
 * stack traces or library internals.
 *
 * Callers own the HTTP status — this helper only owns the body shape.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code?: string;
  errors?: Record<string, unknown>;
}

export function toProblem(
  err: unknown,
  fallback: { type?: string; title?: string; status?: number } = {},
): ProblemDetails {
  if (isAfpsError(err)) {
    const out: ProblemDetails = {
      type: fallback.type ?? `https://errors.appstrate.dev/${err.code}`,
      title: fallback.title ?? err.name,
      status: fallback.status ?? 422,
      detail: err.message,
      code: err.code,
    };
    if (err.details) out.errors = err.details;
    return out;
  }
  return {
    type: fallback.type ?? "about:blank",
    title: fallback.title ?? "Internal Server Error",
    status: fallback.status ?? 500,
    detail: err instanceof Error ? err.message : String(err),
  };
}

// Re-export every typed error so consumers have a single barrel.
export {
  BundleError,
  BundleSignaturePolicyError,
  AfpsEntrypointError,
  type BundleErrorCode,
  type SignaturePolicyReason,
  type AfpsEntrypointErrorCode,
};
