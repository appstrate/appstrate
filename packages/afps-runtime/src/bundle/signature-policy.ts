// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * 3-state signature policy wrapper on top of {@link verifyBundleSignature}.
 *
 * Policies:
 *   - "off"       → no verification. Returns without touching the bundle.
 *   - "warn"      → verify if the bundle carries a signature; call `onWarn`
 *                   on unsigned or invalid bundles but do not throw.
 *   - "required"  → reject unsigned and invalid bundles by throwing
 *                   {@link BundleSignaturePolicyError}.
 *
 * Trust root parsing + bundle loading stay with the caller — this
 * helper only owns the policy / verification branch.
 */

import type { Bundle } from "./types.ts";
import {
  canonicalBundleDigest,
  readBundleSignature,
  verifyBundleSignature,
  type TrustRoot,
  type VerifySignatureFailureReason,
} from "./signing.ts";

export type SignaturePolicy = "off" | "warn" | "required";

export type SignaturePolicyReason = VerifySignatureFailureReason | "unsigned";

export class BundleSignaturePolicyError extends Error {
  readonly code: SignaturePolicyReason | "unsigned_required";
  readonly detail?: string;

  constructor(code: SignaturePolicyReason | "unsigned_required", message: string, detail?: string) {
    super(message);
    this.name = "BundleSignaturePolicyError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface VerifyBundlePolicyOptions {
  policy: SignaturePolicy;
  /** Required when policy !== "off". */
  trustRoot?: TrustRoot;
  /**
   * Invoked in "warn" mode when the bundle is unsigned or the signature
   * fails verification. Detail mirrors the runtime's `detail` field when
   * present.
   */
  onWarn?: (reason: SignaturePolicyReason, detail?: string) => void;
  /** Invoked on successful verification; carries the matched `keyId`. */
  onVerified?: (keyId: string) => void;
}

export interface VerifyBundlePolicyOutcome {
  /** "off" | "unsigned-warned" | "verified" | "warned" */
  status: "off" | "unsigned-warned" | "verified" | "warned";
  keyId?: string;
}

/**
 * Apply {@link SignaturePolicy} to `bundle`. Returns the outcome; throws
 * {@link BundleSignaturePolicyError} only under policy "required".
 */
export function verifyBundleWithPolicy(
  bundle: Bundle,
  opts: VerifyBundlePolicyOptions,
): VerifyBundlePolicyOutcome {
  if (opts.policy === "off") {
    return { status: "off" };
  }

  const signature = readBundleSignature(bundle);
  if (!signature) {
    if (opts.policy === "required") {
      throw new BundleSignaturePolicyError(
        "unsigned_required",
        "Bundle is unsigned and policy is required",
      );
    }
    opts.onWarn?.("unsigned");
    return { status: "unsigned-warned" };
  }

  if (!opts.trustRoot) {
    throw new BundleSignaturePolicyError(
      "unsigned_required",
      "trustRoot is required when policy is not 'off'",
    );
  }

  const digest = canonicalBundleDigest(bundle);
  const result = verifyBundleSignature(digest, signature, opts.trustRoot);
  if (!result.ok) {
    if (opts.policy === "required") {
      throw new BundleSignaturePolicyError(
        result.reason,
        `Bundle signature verification failed: ${result.reason}`,
        result.detail,
      );
    }
    opts.onWarn?.(result.reason, result.detail);
    return { status: "warned" };
  }

  opts.onVerified?.(result.keyId);
  return { status: "verified", keyId: result.keyId };
}
