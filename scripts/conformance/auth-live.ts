// SPDX-License-Identifier: Apache-2.0

/**
 * Auth-liveness check for credential-only integrations (`source.kind:none`).
 *
 * Injects a stored credential (per the manifest's auth `delivery`) into a GET
 * against the package's probe endpoint and asserts the provider accepts it.
 * Opt-in + monitor severity:
 *   - probe + credential, expected status   → INFO (live)
 *   - probe + credential, unexpected status → FAIL (token rejected / changed)
 *   - probe + credential, network/SSRF      → SSRF → FAIL, else WARN
 *   - probe but NO credential               → WARN (skipped)
 *   - NO probe                              → [] (uncovered, silent; counted)
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import type { Finding } from "./types.ts";
import { AUTH_PROBES } from "./probes.ts";
import { resolveAccessToken } from "./creds.ts";
import { ssrfGuardedFetch } from "./ssrf-fetch.ts";
import { resolveAfpsHttpDelivery, type AfpsHttpDelivery } from "@appstrate/connect/afps-delivery";

const CHECK = "auth-live";

interface ManifestAuth {
  type?: string;
  credentials?: { schema?: { properties?: Record<string, unknown>; required?: unknown } };
  delivery?: { http?: AfpsHttpDelivery };
}

/** First auth key declared by the manifest (probe default). */
export function firstAuthKey(manifest: Record<string, unknown>): string | undefined {
  const auths = manifest.auths;
  if (auths && typeof auths === "object") {
    const keys = Object.keys(auths);
    return keys[0];
  }
  return undefined;
}

function manifestAuth(
  manifest: Record<string, unknown>,
  authKey: string,
): ManifestAuth | undefined {
  const auth = (manifest.auths as Record<string, unknown> | undefined)?.[authKey];
  return auth && typeof auth === "object" ? (auth as ManifestAuth) : undefined;
}

/**
 * Fields a credential for this auth carries: the ones its `credentials.schema`
 * declares, plus the implicit field of its type (`access_token` for oauth2,
 * `api_key` for api_key — AFPS §4.1.3).
 */
function credentialFieldNames(auth: ManifestAuth): string[] {
  const declared = Object.keys(auth.credentials?.schema?.properties ?? {});
  const implicit =
    auth.type === "oauth2" ? ["access_token"] : auth.type === "api_key" ? ["api_key"] : [];
  return [...new Set([...declared, ...implicit])];
}

/** Credential fields the auth REQUIRES — more than one cannot come from a single secret. */
export function requiredCredentialFields(
  manifest: Record<string, unknown>,
  authKey: string,
): string[] {
  const required = manifestAuth(manifest, authKey)?.credentials?.schema?.required;
  return Array.isArray(required) ? required.filter((f): f is string => typeof f === "string") : [];
}

/**
 * Apply the manifest's auth delivery to a probe request, with every credential
 * field set to `secret`. Rendered by the runtime's own resolver
 * (`resolveAfpsHttpDelivery`), so the probe sends the byte-for-byte header a
 * real run sends: the declared prefix concatenated verbatim (AFPS §7.6), the
 * per-auth-type default when none is declared (`""` for api_key, never a
 * "Bearer " no run sends), and templated values such as Basic
 * `{$credential.account_sid}:{$credential.auth_token}` base64-encoded.
 *
 * Returns `null` when the auth delivers no HTTP header (a `custom` auth, an
 * env-only delivery) — there is nothing a probe could send.
 */
export function applyAuth(
  url: string,
  manifest: Record<string, unknown>,
  secret: string,
  authKey: string,
): { url: string; headers: Record<string, string> } | null {
  const auth = manifestAuth(manifest, authKey);
  if (!auth?.type) return null;
  const fields = Object.fromEntries(credentialFieldNames(auth).map((f) => [f, secret]));
  const plan = resolveAfpsHttpDelivery(auth.type, fields, auth.delivery?.http);
  if (!plan || plan.value.length === 0) return null;
  return {
    url,
    headers: {
      Accept: "application/json",
      "User-Agent": "Appstrate",
      [plan.headerName]: `${plan.headerPrefix}${plan.value}`,
    },
  };
}

export async function checkAuthLiveness(
  entry: SystemPackageEntry,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<Finding[]> {
  const probe = AUTH_PROBES[entry.packageId];
  if (!probe) return []; // uncovered — silent, counted by the runner

  let token: string | undefined;
  try {
    token = await resolveAccessToken(entry);
  } catch (err) {
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "warn",
        message: `credential refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }
  if (!token) {
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "warn",
        message: `probe configured (${probe.url}) but no credential — skipped`,
      },
    ];
  }

  if (isBlockedUrl(probe.url)) {
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "fail",
        message: `probe url ${probe.url} is blocked by the SSRF guard`,
      },
    ];
  }

  const authKey = probe.authKey ?? firstAuthKey(entry.manifest);
  if (!authKey) {
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "fail",
        message: "no auth declared on the manifest — cannot deliver a credential",
      },
    ];
  }

  const required = requiredCredentialFields(entry.manifest, authKey);
  if (required.length > 1) {
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "warn",
        message: `auth '${authKey}' needs several credential fields (${required.join(", ")}); a CONFORMANCE_TOKENS entry carries one secret — skipped`,
      },
    ];
  }
  const request = applyAuth(probe.url, entry.manifest, token, authKey);
  if (!request) {
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "fail",
        message: `auth '${authKey}' declares no HTTP credential delivery — a probe cannot deliver the credential`,
      },
    ];
  }
  const { url, headers } = request;
  const fetchImpl = opts.fetchImpl ?? ssrfGuardedFetch;

  try {
    const res = await fetchImpl(url, { method: "GET", headers });
    if (probe.expectStatus.includes(res.status)) {
      return [
        {
          packageId: entry.packageId,
          check: CHECK,
          severity: "info",
          message: `live — provider accepted the credential (status ${res.status})`,
        },
      ];
    }
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "fail",
        message: `unexpected status ${res.status} (expected ${probe.expectStatus.join("/")}) — credential rejected or endpoint moved`,
      },
    ];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: message.includes("SSRF guard") ? "fail" : "warn",
        message: `probe request failed: ${message}`,
      },
    ];
  }
}
