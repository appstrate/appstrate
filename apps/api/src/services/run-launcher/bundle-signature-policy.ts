// SPDX-License-Identifier: Apache-2.0

/**
 * Bundle signature policy — the thin layer between the platform's
 * configuration (`AFPS_TRUST_ROOT` + `AFPS_SIGNATURE_POLICY` env vars)
 * and the runtime's signing primitives.
 *
 * The 3-state policy (off / warn / required) lives in the runtime — see
 * `verifyBundleWithPolicy` in `@appstrate/afps-runtime/bundle`. This
 * wrapper owns trust-root parsing, logging wiring, and translation of
 * the runtime's `BundleSignaturePolicyError` into a platform-typed
 * error that carries the offending `packageId`.
 *
 * See docs/adr/ADR-009-afps-bundle-signing-ed25519-to-sigstore.md.
 */

import { z } from "zod";
import {
  buildBundleFromAfps,
  emptyPackageCatalog,
  verifyBundleWithPolicy,
  BundleSignaturePolicyError,
  type Bundle,
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
): Promise<Bundle | null> {
  const policy = getEnv().AFPS_SIGNATURE_POLICY;
  if (policy === "off") return null;

  const bundle = await buildBundleFromAfps(buffer, emptyPackageCatalog);

  try {
    verifyBundleWithPolicy(bundle, {
      policy,
      trustRoot: getTrustRoot(),
      onWarn: (reason, detail) => {
        if (reason === "unsigned") {
          logger.warn("AFPS bundle is unsigned", { packageId });
        } else {
          logger.warn("AFPS bundle signature invalid", { packageId, reason, detail });
        }
      },
      onVerified: (keyId) => {
        logger.debug("AFPS bundle signature verified", { packageId, keyId });
      },
    });
  } catch (err) {
    if (err instanceof BundleSignaturePolicyError) {
      // Runtime's "unsigned" code only surfaces via onWarn (warn mode);
      // "required" mode raises "unsigned_required" instead — so the only
      // codes that can land here are signature failure reasons or
      // "unsigned_required". The fallback narrows the runtime's broader
      // union to the platform error contract.
      const code =
        err.code === "unsigned"
          ? "unsigned_required"
          : (err.code as VerifySignatureFailureReason | "unsigned_required");
      throw new BundleSignatureError(
        code,
        packageId,
        `Bundle signature verification failed for ${packageId}: ${err.message}`,
        err.detail,
      );
    }
    throw err;
  }

  return bundle;
}
