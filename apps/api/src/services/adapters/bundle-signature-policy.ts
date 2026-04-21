// SPDX-License-Identifier: Apache-2.0

/**
 * Bundle signature policy — the thin layer between the platform's
 * configuration (`AFPS_TRUST_ROOT` + `AFPS_SIGNATURE_POLICY` env vars)
 * and the runtime's signing primitives.
 *
 * Policies:
 *   - "off"       — no verification. Unsigned and invalid bundles load.
 *   - "warn"      — verify if the bundle carries a signature; log a
 *                   warning on unsigned or invalid bundles but still
 *                   return the loaded bundle.
 *   - "required"  — reject unsigned and invalid bundles at load time
 *                   (throws `BundleSignatureError`).
 *
 * See docs/adr/ADR-009-afps-bundle-signing-ed25519-to-sigstore.md for
 * the design rationale (Ed25519 v1 → Sigstore keyless v2).
 */

import { z } from "zod";
import {
  canonicalBundleDigest,
  loadBundleFromBuffer,
  readBundleSignature,
  verifyBundleSignature,
  type LoadedBundle,
  type TrustRoot,
  type TrustedKey,
  type VerifySignatureFailureReason,
} from "@appstrate/afps-runtime/bundle";
import { getEnv } from "@appstrate/env";
import { logger } from "../../lib/logger.ts";

/**
 * Error thrown when a bundle's signature fails verification under the
 * "required" policy. `code` mirrors the runtime's machine-readable
 * failure reasons + two extra codes for policy-level rejections.
 */
export class BundleSignatureError extends Error {
  constructor(
    public readonly code: VerifySignatureFailureReason | "unsigned_required" | "policy_error",
    public readonly packageId: string,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "BundleSignatureError";
  }
}

const trustedKeySchema = z.object({
  keyId: z.string().min(1),
  publicKey: z.string().min(1),
  comment: z.string().optional(),
});

type TrustedKeyInput = z.infer<typeof trustedKeySchema>;

let cachedTrustRoot: TrustRoot | null = null;

/**
 * Parse `AFPS_TRUST_ROOT` once and cache the result. Invalid entries
 * fail-fast at first access — malformed trust config is a security
 * issue we do not want to silently absorb.
 */
export function getTrustRoot(): TrustRoot {
  if (cachedTrustRoot) return cachedTrustRoot;
  const raw = getEnv().AFPS_TRUST_ROOT;
  if (!Array.isArray(raw)) {
    throw new Error("AFPS_TRUST_ROOT must be a JSON array");
  }
  const keys: TrustedKey[] = raw.map((entry, i) => {
    const result = trustedKeySchema.safeParse(entry);
    if (!result.success) {
      throw new Error(
        `AFPS_TRUST_ROOT[${i}] is invalid: ${result.error.issues
          .map((issue) => issue.message)
          .join(", ")}`,
      );
    }
    const key: TrustedKeyInput = result.data;
    const decoded = Buffer.from(key.publicKey, "base64");
    if (decoded.length !== 32) {
      throw new Error(
        `AFPS_TRUST_ROOT[${i}].publicKey must decode to 32 bytes (got ${decoded.length})`,
      );
    }
    return {
      keyId: key.keyId,
      publicKey: key.publicKey,
      ...(key.comment !== undefined ? { comment: key.comment } : {}),
    };
  });
  cachedTrustRoot = { keys };
  return cachedTrustRoot;
}

/** Reset the cached trust root — tests only. */
export function _resetTrustRootCacheForTesting(): void {
  cachedTrustRoot = null;
}

/**
 * Load a bundle buffer + apply the configured signature policy.
 *
 * Returns the loaded bundle (validated + size-capped by the runtime
 * loader). Throws {@link BundleSignatureError} only under the "required"
 * policy when the bundle is unsigned or fails verification.
 */
export async function loadAndVerifyBundle(
  buffer: Uint8Array,
  packageId: string,
): Promise<LoadedBundle> {
  const bundle = await loadBundleFromBuffer(buffer);
  const policy = getEnv().AFPS_SIGNATURE_POLICY;
  if (policy === "off") return bundle;

  const signature = readBundleSignature(bundle);
  if (!signature) {
    if (policy === "required") {
      throw new BundleSignatureError(
        "unsigned_required",
        packageId,
        `Bundle for ${packageId} is unsigned and AFPS_SIGNATURE_POLICY=required`,
      );
    }
    // warn mode
    logger.warn("AFPS bundle is unsigned", { packageId });
    return bundle;
  }

  const digest = canonicalBundleDigest(bundle.files);
  const result = verifyBundleSignature(digest, signature, getTrustRoot());
  if (!result.ok) {
    if (policy === "required") {
      throw new BundleSignatureError(
        result.reason,
        packageId,
        `Bundle signature verification failed for ${packageId}: ${result.reason}`,
        result.detail,
      );
    }
    logger.warn("AFPS bundle signature invalid", {
      packageId,
      reason: result.reason,
      detail: result.detail,
    });
    return bundle;
  }

  logger.debug("AFPS bundle signature verified", { packageId, keyId: result.keyId });
  return bundle;
}
