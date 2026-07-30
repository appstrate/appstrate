// SPDX-License-Identifier: Apache-2.0

/**
 * Map bundle-layer failures onto the platform's RFC 9457 error contract.
 *
 * Every run against a published version assembles its bundle from stored
 * artifacts: each dependency ZIP is downloaded, checked against the SRI
 * recorded at publish time, run through the AFPS signature policy, and walked
 * for its dependency closure. All of those steps fail on *stored state*, not
 * on the request — and each one throws.
 *
 * Every bundle-layer throw must map here: anything left unmapped reaches the
 * global handler as an opaque `500 internal_error` with no `detail`, leaving
 * the caller (and support) with nothing to act on (#878). The draft path never
 * crosses the integrity/signature gate, so these failures only ever surface on
 * published runs. `bundle-error-mapping.test.ts` enforces exhaustiveness over
 * the `BundleErrorCode` union.
 *
 * Status choice splits on *whose* fault it is:
 *
 *   - `INTEGRITY_MISMATCH` → **500**. The bytes at rest no longer hash to the
 *     SRI recorded at publish time: corruption or tampering. That is an
 *     operator-visible fault and must stay on the server's error budget rather
 *     than being laundered into a 4xx. It now carries a stable code and a
 *     detail, so it is actionable rather than opaque.
 *   - everything else → **422**. The request is well-formed but the stored
 *     package cannot be assembled. The org fixes it by republishing, pinning a
 *     different version, or passing `dependency_overrides`.
 *
 * Returns `null` for anything that is not a bundle-layer error, so callers
 * rethrow it untouched.
 */

import { BundleError } from "@appstrate/afps-runtime/bundle";
import { ApiError } from "../../lib/errors.ts";
import { BundleSignatureError } from "./bundle-signature-policy.ts";

interface UnresolvedDependency {
  name: string;
  versionSpec: string;
}

/**
 * Turn a `DEPENDENCY_UNRESOLVED` error into a sentence naming what failed and
 * what to do about it.
 *
 * The code is raised from two places whose remedies differ:
 *
 *   - the closure walk (`buildBundleFromCatalog`) collects every pin that
 *     resolved to NO version into `details.missing` — publish the dependency or
 *     change the pin.
 *   - a catalog's `fetch()` fails on ONE already-resolved dependency whose bytes
 *     are unusable (absent from storage, or out of the org's scope) and carries
 *     `details.identity` — the pin resolved, so "fix the pin" would misdirect.
 */
function formatUnresolved(details: unknown): string {
  const ctx = details as { missing?: UnresolvedDependency[]; identity?: string } | undefined;
  if (ctx?.missing && ctx.missing.length > 0) {
    const names = ctx.missing.map((m) => `'${m.name}@${m.versionSpec}'`).join(", ");
    return `Could not resolve ${names} against published versions — publish the dependency, fix the pin, or pass \`dependency_overrides\` to run a working copy.`;
  }
  if (typeof ctx?.identity === "string") {
    return `Dependency '${ctx.identity}' resolved to a published version whose artifact could not be loaded — republish that version, or pass \`dependency_overrides\` to run a working copy.`;
  }
  return "Could not resolve a declared dependency against published versions — publish the dependency, fix the pin, or pass `dependency_overrides` to run a working copy.";
}

/**
 * Translate a bundle-layer throw into an `ApiError`, or `null` when `err` did
 * not originate there.
 */
export function toBundleApiError(err: unknown): ApiError | null {
  // Signature policy rejection (`AFPS_SIGNATURE_POLICY=required` over an
  // unsigned or badly-signed bundle). Deterministic and org-fixable, so 422.
  if (err instanceof BundleSignatureError) {
    return new ApiError({
      status: 422,
      code: "bundle_signature_invalid",
      title: "Bundle Signature Invalid",
      detail: `The stored bundle for '${err.packageId}' failed the AFPS signature policy (${err.code}) — republish it signed by a trusted key, or relax AFPS_SIGNATURE_POLICY.`,
    });
  }

  if (!(err instanceof BundleError)) return null;

  switch (err.code) {
    // A dependency pin that resolves to nothing — an unsatisfiable range or a
    // never-published skill. Fail loud BEFORE the container starts, never a
    // silent draft fallback (#666). The detail names the unresolved deps and
    // the fix.
    case "DEPENDENCY_UNRESOLVED":
      return new ApiError({
        status: 422,
        code: "dependency_unresolved",
        title: "Dependency Unresolved",
        detail: formatUnresolved(err.details),
      });

    case "INTEGRITY_MISMATCH":
      return new ApiError({
        status: 500,
        code: "bundle_integrity_mismatch",
        title: "Bundle Integrity Mismatch",
        detail: `A stored package artifact no longer matches the integrity hash recorded when it was published, and was refused. Republish the affected package. (${err.message})`,
      });

    // Archive/manifest/limit failures over stored bytes: the bundle exists but
    // cannot be assembled into a runnable package.
    default:
      return new ApiError({
        status: 422,
        code: "bundle_invalid",
        title: "Bundle Invalid",
        detail: `The stored bundle could not be assembled (${err.code}): ${err.message}`,
      });
  }
}
