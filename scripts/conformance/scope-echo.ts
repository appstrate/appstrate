// SPDX-License-Identifier: Apache-2.0

/**
 * Scope-echo coverage check for `oauth2` auths — deterministic, no network,
 * every tier.
 *
 * A connection's `scopes_granted` is whatever the token response echoes in
 * its `scope` field, and readiness compares the scopes an agent requires
 * against that set once expanded through the auth's `scope_catalog[].implies`
 * (`missingScopesForConnection`). Some identity providers do not echo a
 * requested scope verbatim: Google rewrites the OIDC short scope `email` to
 * `https://www.googleapis.com/auth/userinfo.email`. A manifest that requests
 * `email` without a catalog entry mapping the echoed form back to it reports
 * `email` as missing on EVERY connection — a reconnect loop the user cannot
 * escape, and a 412 at run launch for any agent with `tools: "*"` (#1131).
 *
 * Nothing at authoring time sees the echo, so this check encodes the known
 * rewrites per issuer ({@link ISSUER_SCOPE_ECHOES}) and requires that the
 * echoed scope, expanded with the platform's own `expandScopesGranted`,
 * covers the scope it replaces. The fix is always one catalog entry:
 * `{ value: <echoed>, implies: [<requested>] }`.
 */

import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import { expandScopesGranted, type IntegrationManifest } from "@appstrate/core/integration";
import type { Finding } from "./types.ts";

const CHECK = "scope-echo";

/**
 * Observed IdP scope rewrites, keyed by OAuth `issuer`: requested scope →
 * the scope the token response echoes instead. IdP-behaviour test data for
 * authoring time only; nothing at runtime reads it.
 *
 * Google: `email` is the observed echo on production connections
 * (`@appstrate/gmail`, `@appstrate/google-drive`, 2026-09-23 — they store
 * `userinfo.email` + `openid`, never `email`). Both entries are documented
 * equivalences in "Google OAuth2 API, v2" at
 * https://developers.google.com/identity/protocols/oauth2/scopes#oauth2.
 */
const ISSUER_SCOPE_ECHOES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "https://accounts.google.com": {
    email: "https://www.googleapis.com/auth/userinfo.email",
    profile: "https://www.googleapis.com/auth/userinfo.profile",
  },
};

/** Check every `oauth2` auth whose issuer has known scope rewrites. */
export function checkScopeEcho(entry: SystemPackageEntry): Finding[] {
  // Archives are schema-validated at load (`parsePackageZip` → `validateManifest`),
  // so the raw record already has the `IntegrationManifest` shape.
  const manifest = entry.manifest as unknown as IntegrationManifest;
  return Object.entries(manifest.auths ?? {}).flatMap(([authKey, auth]) => {
    if (auth.type !== "oauth2" || typeof auth.issuer !== "string") return [];
    const echoes = ISSUER_SCOPE_ECHOES[auth.issuer];
    if (!echoes) return [];
    const requested = new Set([
      ...(auth.default_scopes ?? []),
      ...(auth.scope_catalog ?? []).map((s) => s.value),
    ]);
    return [...requested].flatMap((scope) => {
      const echoed = echoes[scope];
      if (!echoed || expandScopesGranted([echoed], manifest, authKey).includes(scope)) return [];
      return [
        {
          packageId: entry.packageId,
          check: CHECK,
          severity: "fail" as const,
          message:
            `${authKey}: requests "${scope}" but ${auth.issuer} echoes "${echoed}" instead, ` +
            `so "${scope}" is reported missing on every connection. Add ` +
            `{ "value": "${echoed}", "implies": ["${scope}"] } to auths.${authKey}.scope_catalog`,
        },
      ];
    });
  });
}
