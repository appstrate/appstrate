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

const CHECK = "auth-live";

interface DeliveryHttp {
  in?: string;
  name?: string;
  prefix?: string;
}

/** First auth key declared by the manifest (probe default). */
function firstAuthKey(manifest: Record<string, unknown>): string | undefined {
  const auths = manifest.auths;
  if (auths && typeof auths === "object") {
    const keys = Object.keys(auths);
    return keys[0];
  }
  return undefined;
}

function deliveryHttp(
  manifest: Record<string, unknown>,
  authKey: string,
): DeliveryHttp | undefined {
  const auths = manifest.auths as Record<string, unknown> | undefined;
  const auth = auths?.[authKey];
  if (auth && typeof auth === "object") {
    const delivery = (auth as { delivery?: unknown }).delivery;
    if (delivery && typeof delivery === "object") {
      const http = (delivery as { http?: unknown }).http;
      if (http && typeof http === "object") return http as DeliveryHttp;
    }
  }
  return undefined;
}

/**
 * Apply the manifest's auth delivery to a probe request. Header delivery sets
 * `<name>: <prefix> <token>`; query delivery appends `<name>=<token>`. Falls
 * back to a Bearer Authorization header when no delivery is declared.
 */
export function applyAuth(
  url: string,
  manifest: Record<string, unknown>,
  token: string,
  authKey: string,
): { url: string; headers: Record<string, string> } {
  const http = deliveryHttp(manifest, authKey);
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Appstrate" };

  if (http?.in === "query" && http.name) {
    const u = new URL(url);
    u.searchParams.set(http.name, token);
    return { url: u.toString(), headers };
  }

  const name = http?.name ?? "Authorization";
  const prefix = http?.prefix ?? "Bearer";
  // Prefixes are declared with or without a trailing space ("Bearer" vs
  // "Bearer "); normalise to exactly one separating space.
  const value = prefix ? `${prefix.trimEnd()} ${token}` : token;
  headers[name] = value;
  return { url, headers };
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

  const { url, headers } = applyAuth(probe.url, entry.manifest, token, authKey);
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
