// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Unified runtime error taxonomy for `@appstrate/afps-runtime`.
 *
 * The package ships typed errors close to where they are raised
 * (`BundleError`, `BundleSignaturePolicyError`). This module sits at the top
 * so consumers can import every typed error from a single subpath
 * (`@appstrate/afps-runtime/errors`).
 *
 * Two classes are raised here: {@link ResolverError} (generic resolver wiring
 * and outbound-HTTP body/path refusals) and {@link AuthorizedUrisError} (an
 * `api_call` target outside its allowlist). The platform serialises them
 * through `@appstrate/core/api-errors` plus
 * `run-launcher/bundle-error-mapping.ts`, which translates this taxonomy into
 * the platform's own error catalogue.
 *
 * The base class is structural — `name`, `code`, `message`, optional
 * `details`, optional `cause`. `cause` reaches it through the fourth
 * constructor argument of BOTH concrete classes, so a resolver that refuses
 * inside a `catch` can carry the error it caught instead of dropping it; the
 * argument is `ErrorOptions`, NOT the `details` bag, so the chain stays
 * operator-facing and `formatErrorChain` can walk it. We do not introduce a runtime
 * `instanceof AfpsRuntimeError` check anywhere because the existing typed
 * errors (BundleError, BundleSignaturePolicyError, …) predate this
 * module and we do not want to break user code that does
 * `instanceof BundleError`.
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
  | "AUTHORIZED_URIS_EMPTY"
  | "AUTHORIZED_URIS_MISMATCH"
  | ResolverErrorCode;

/**
 * Structural shape every typed error in this module satisfies.
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

/** An integration `api_call` tool tried to call a target outside its allowlist. */
export class AuthorizedUrisError extends AfpsRuntimeError {
  override readonly name = "AuthorizedUrisError";
  readonly code: "AUTHORIZED_URIS_EMPTY" | "AUTHORIZED_URIS_MISMATCH";

  constructor(
    code: "AUTHORIZED_URIS_EMPTY" | "AUTHORIZED_URIS_MISMATCH",
    message: string,
    details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, details, options);
    this.code = code;
  }
}

/** Generic resolver wiring failure (bad tool shape, missing entrypoint metadata, etc). */
export class ResolverError extends AfpsRuntimeError {
  override readonly name = "ResolverError";
  readonly code: ResolverErrorCode;

  constructor(
    code: ResolverErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, details, options);
    this.code = code;
  }
}

// Re-export every typed error so consumers have a single barrel.
export {
  BundleError,
  BundleSignaturePolicyError,
  type BundleErrorCode,
  type SignaturePolicyReason,
};
