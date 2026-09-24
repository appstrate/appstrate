// SPDX-License-Identifier: Apache-2.0

/**
 * Identity-source declaration check for `oauth2` auths — deterministic, no
 * network, every tier.
 *
 * A connection's `accountId` is what tells two connections to the same
 * provider apart. `extractIdentity` builds it from `identity_claims` when the
 * manifest maps one, and otherwise only from a top-level `email` /
 * `account_email` / `sub` in the identity source — which is the token response
 * plus, when the platform knows where to fetch it, a userinfo document
 * (`userinfo_endpoint`, or the one an `issuer`'s discovery advertises). A
 * manifest that declares none of `identity_claims`, `userinfo_endpoint` and
 * `issuer` therefore depends on the provider putting one of those three keys
 * at the top level of its token response; few do, and every connection then
 * resolves to accountId `"default"` and collapses onto one account key.
 *
 * Nothing refuses such a manifest and nothing at runtime says so beyond a
 * default label, so this is a WARN: the author has to either map the identity
 * the provider does return (Slack reads `authed_user.id` straight off its
 * token response) or declare where to fetch it.
 */

import { findNonSnakeCaseIdentityClaimKeys } from "@appstrate/core/integration";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import type { Finding } from "./types.ts";

const CHECK = "identity-source";

interface OAuthAuthShape {
  type?: unknown;
  identity_claims?: unknown;
  userinfo_endpoint?: unknown;
  issuer?: unknown;
}

export function checkIdentitySource(entry: SystemPackageEntry): Finding[] {
  const auths = entry.manifest.auths;
  if (!auths || typeof auths !== "object") return [];
  return Object.entries(auths as Record<string, OAuthAuthShape>).flatMap(([authKey, auth]) => {
    if (!auth || auth.type !== "oauth2") return [];
    const hasMapping =
      !!auth.identity_claims &&
      typeof auth.identity_claims === "object" &&
      Object.keys(auth.identity_claims).length > 0;
    if (
      hasMapping ||
      typeof auth.userinfo_endpoint === "string" ||
      typeof auth.issuer === "string"
    ) {
      return [];
    }
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "warn" as const,
        message: `${authKey}: no identity source — no identity_claims, userinfo_endpoint or issuer, so accountId is "default" unless the token response itself carries email/sub, and every connection shares one account key`,
      },
    ];
  });
}

/**
 * The identity-claim key casing the API enforces on every package write
 * (`CONFIG_BY_TYPE.checkManifest`), applied to system manifests — which reach
 * the platform through the build, not through a write route. FAIL.
 */
export function checkIdentityClaimKeys(entry: SystemPackageEntry): Finding[] {
  return findNonSnakeCaseIdentityClaimKeys(entry.manifest).map((v) => ({
    packageId: entry.packageId,
    check: "identity-claim-keys",
    severity: "fail" as const,
    message: `${v.path.join(".")}: ${v.message}`,
  }));
}
