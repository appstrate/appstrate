// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Unified runtime error taxonomy for `@appstrate/afps-runtime`.
 *
 * The package already ships several typed errors close to where they
 * are raised (`BundleError`, `BundleSignaturePolicyError`,
 * `RunTimeoutError`). This module sits at the
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

/** Machine-readable codes for {@link ResolverError} — the generic resolver
 * wiring taxonomy shared by the runtime and the standalone `afps` CLI. */
export type ResolverErrorCode =
  | "RESOLVER_MISSING_REQUIRED"
  | "RESOLVER_BODY_REFERENCE_FORBIDDEN"
  | "RESOLVER_BODY_TOO_LARGE"
  | "RESOLVER_BODY_INVALID"
  | "RESOLVER_PATH_OUTSIDE_ALLOWED_ROOTS"
  | "RESOLVER_PATH_SYMLINK_REFUSED"
  | "RESOLVER_PATH_INVALID"
  // The standalone CLI's `LocalIntegrationResolver` surfaces these
  // when the shared outbound-HTTP engine refuses the initial target
  // (SSRF blocklist) or a redirect hop (per-hop SSRF / off-allowlist).
  | "RESOLVER_URL_BLOCKED"
  | "RESOLVER_REDIRECT_BLOCKED"
  | "RESOLVER_CREDENTIAL_EXFIL_BLOCKED";

/** Stable, machine-readable code for every error class in this module. */
export type AfpsErrorCode =
  | BundleErrorCode
  | SignaturePolicyReason
  | "unsigned_required"
  | "RUN_TIMEOUT"
  | "RUN_CANCELLED"
  | "WORKLOAD_EXIT_NONZERO"
  | "AUTHORIZED_URIS_EMPTY"
  | "AUTHORIZED_URIS_MISMATCH"
  | ResolverErrorCode
  | "RUN_HISTORY_FETCH_FAILED"
  | "RUN_HISTORY_BAD_RESPONSE"
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

/** An integration `api_call` tool tried to call a target outside its allowlist. */
export class AuthorizedUrisError extends AfpsRuntimeError {
  override readonly name = "AuthorizedUrisError";
  readonly code: "AUTHORIZED_URIS_EMPTY" | "AUTHORIZED_URIS_MISMATCH";

  constructor(
    code: "AUTHORIZED_URIS_EMPTY" | "AUTHORIZED_URIS_MISMATCH",
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
  readonly code: ResolverErrorCode;

  constructor(code: ResolverErrorCode, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}

/** A `run_history` sidecar fetch failed (HTTP, JSON, or shape). */
export class RunHistoryError extends AfpsRuntimeError {
  override readonly name = "RunHistoryError";
  readonly code: "RUN_HISTORY_FETCH_FAILED" | "RUN_HISTORY_BAD_RESPONSE";

  constructor(
    code: "RUN_HISTORY_FETCH_FAILED" | "RUN_HISTORY_BAD_RESPONSE",
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

/**
 * Canonical documentation root for RFC 9457 `type` URIs — the same host
 * and `/errors` root `codeToType()` in `@appstrate/core/api-errors` uses,
 * so there is ONE documentation host rather than two dead subdomains.
 */
const DOCS_ERRORS_ROOT = "https://docs.appstrate.dev/errors";

/**
 * Path segment separating the runtime taxonomy from the platform's API
 * error catalogue.
 *
 * The two catalogues are independent and **do** overlap: `INTEGRITY_MISMATCH`
 * here means "stored bytes no longer hash to their recorded SRI", while the
 * platform's `integrity_mismatch` means "this version already exists with
 * different content" (409). `run-launcher/bundle-error-mapping.ts` maps the
 * former to `bundle_integrity_mismatch`, precisely because they are not the
 * same thing. Sharing a flat `/errors/{code}` namespace would point both at
 * one document.
 *
 * Renaming a code on either side is a wire-breaking change, so the namespace
 * is separated by path instead. That makes the collision structurally
 * impossible rather than merely documented, and keeps the single-host
 * consolidation.
 */
const AFPS_NAMESPACE = "afps";

/**
 * Slug transform, kept identical to core's: underscores become dashes,
 * with no case folding (so `RUN_TIMEOUT` yields `RUN-TIMEOUT`). The
 * duplication is deliberate — `@appstrate/core` is a devDependency here,
 * not a runtime one. This package is published, powers the standalone
 * `afps` CLI, and is kept to a small portable dependency set; importing
 * core's helper would either break every npm consumer (the module is not
 * installed for them) or drag core — ajv, pino, and the rest — into the
 * runtime closure of a portable AFPS runtime, inverting the layering.
 *
 * `test/errors.test.ts` asserts both implementations share the host and
 * `/errors` root, apply the same slug transform, and differ by exactly the
 * `afps/` segment. `apps/api/test/unit/error-uri-namespaces.test.ts`
 * asserts the two catalogues never produce a colliding URI.
 */
function codeToSlug(code: string): string {
  return code.replace(/_/g, "-");
}

/** RFC 9457 `type` URI for a runtime error code. */
export function afpsErrorTypeUri(code: string): string {
  return `${DOCS_ERRORS_ROOT}/${AFPS_NAMESPACE}/${codeToSlug(code)}`;
}

/**
 * Every member of {@link AfpsErrorCode}.
 *
 * `satisfies Record<AfpsErrorCode, true>` makes this exhaustive in both
 * directions at compile time: a code added to the union without an entry
 * here fails to build, and an entry that is not a member fails too. The
 * URI-disjointness test enumerates this list, so an un-enumerated code
 * would otherwise slip past it unchecked.
 */
const AFPS_ERROR_CODE_TABLE = {
  ARCHIVE_INVALID: true,
  BUNDLE_JSON_MISSING: true,
  BUNDLE_JSON_INVALID: true,
  RECORD_MISSING: true,
  RECORD_MALFORMED: true,
  RECORD_MISMATCH: true,
  INTEGRITY_MISMATCH: true,
  VERSION_UNSUPPORTED: true,
  LIMITS_EXCEEDED: true,
  MANIFEST_SCHEMA: true,
  DEPENDENCY_UNRESOLVED: true,
  TOOL_BUNDLE_FAILED: true,
  signature_invalid: true,
  alg_unsupported: true,
  chain_untrusted: true,
  chain_invalid: true,
  chain_missing: true,
  malformed: true,
  unsigned: true,
  unsigned_required: true,
  RUN_TIMEOUT: true,
  RUN_CANCELLED: true,
  WORKLOAD_EXIT_NONZERO: true,
  AUTHORIZED_URIS_EMPTY: true,
  AUTHORIZED_URIS_MISMATCH: true,
  RESOLVER_MISSING_REQUIRED: true,
  RESOLVER_BODY_REFERENCE_FORBIDDEN: true,
  RESOLVER_BODY_TOO_LARGE: true,
  RESOLVER_BODY_INVALID: true,
  RESOLVER_PATH_OUTSIDE_ALLOWED_ROOTS: true,
  RESOLVER_PATH_SYMLINK_REFUSED: true,
  RESOLVER_PATH_INVALID: true,
  RESOLVER_URL_BLOCKED: true,
  RESOLVER_REDIRECT_BLOCKED: true,
  RESOLVER_CREDENTIAL_EXFIL_BLOCKED: true,
  RUN_HISTORY_FETCH_FAILED: true,
  RUN_HISTORY_BAD_RESPONSE: true,
  CREDENTIAL_RESOLUTION: true,
} as const satisfies Record<AfpsErrorCode, true>;

/** Every {@link AfpsErrorCode}, enumerable at runtime. */
export const AFPS_ERROR_CODES: readonly AfpsErrorCode[] = Object.keys(
  AFPS_ERROR_CODE_TABLE,
) as AfpsErrorCode[];

export function toProblem(
  err: unknown,
  fallback: { type?: string; title?: string; status?: number } = {},
): ProblemDetails {
  if (isAfpsError(err)) {
    const out: ProblemDetails = {
      type: fallback.type ?? afpsErrorTypeUri(err.code),
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
  type BundleErrorCode,
  type SignaturePolicyReason,
};
