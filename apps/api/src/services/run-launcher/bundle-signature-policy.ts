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
 */

import { z } from "zod";
import { unzipSync } from "fflate";
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
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../../lib/logger.ts";
import { isSystemPackage } from "../system-packages.ts";

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
function getTrustRoot(): TrustRoot {
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

/**
 * Boot hook: parse `AFPS_TRUST_ROOT` now (a malformed entry fails boot, not the
 * first run) and log the effective policy so an operator can see it.
 */
export function initBundleSignaturePolicy(): void {
  logger.info("AFPS bundle signature policy", {
    policy: getEnv().AFPS_SIGNATURE_POLICY,
    trustedKeys: getTrustRoot().keys.length,
  });
}

/** Reset the cached trust root — tests only. */
export function _resetTrustRootCacheForTesting(): void {
  cachedTrustRoot = null;
}

/**
 * Apply the configured signature policy to one stored package about to be
 * executed. Returns the loaded bundle, or `null` when nothing was verified.
 * Only `required` throws; `warn` is observation-only and never fails a run.
 */
export async function loadAndVerifyBundle(
  buffer: Uint8Array,
  packageId: string,
): Promise<Bundle | null> {
  const policy = getEnv().AFPS_SIGNATURE_POLICY;
  // System packages are write-protected and ship unsigned: the image is their
  // trust root.
  if (policy === "off" || isSystemPackage(packageId)) return null;
  if (policy === "required") return verifyOrThrow(buffer, packageId, policy);
  // Most archives are unsigned: the zip central directory answers that cheaply.
  if (!mayCarrySignature(buffer)) {
    logger.debug("AFPS bundle is unsigned", { packageId });
    return null;
  }
  try {
    return await verifyOrThrow(buffer, packageId, policy);
  } catch (err) {
    logger.warn("AFPS bundle signature could not be checked", {
      packageId,
      error: getErrorMessage(err),
    });
    return null;
  }
}

const SIGNATURE_ENTRY = "signature.sig";

/**
 * Whether the archive has a `signature.sig` entry, read from the central
 * directory only (nothing is inflated). An unreadable archive answers `true`
 * so the full load reports it.
 */
function mayCarrySignature(buffer: Uint8Array): boolean {
  let found = false;
  try {
    unzipSync(buffer, {
      filter: (f) => {
        if (f.name === SIGNATURE_ENTRY || f.name.endsWith(`/${SIGNATURE_ENTRY}`)) found = true;
        return false;
      },
    });
  } catch {
    return true;
  }
  return found;
}

async function verifyOrThrow(
  buffer: Uint8Array,
  packageId: string,
  policy: "warn" | "required",
): Promise<Bundle> {
  // Dependencies are separate objects, each verified when loaded.
  const bundle = await buildBundleFromAfps(buffer, emptyPackageCatalog, { depTypes: [] });

  try {
    verifyBundleWithPolicy(bundle, {
      policy,
      trustRoot: getTrustRoot(),
      onWarn: (reason, detail) => {
        if (reason === "unsigned") {
          logger.debug("AFPS bundle is unsigned", { packageId });
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
