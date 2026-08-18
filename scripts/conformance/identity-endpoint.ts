// SPDX-License-Identifier: Apache-2.0

/**
 * Liveness check for manifest-declared `userinfo_endpoint`s — no credentials.
 *
 * An `identity_claims` mapping is only as good as the URL it reads from, and a
 * wrong URL fails silently: `oauth2-strategy` logs a warning nobody reads, then
 * falls back to accountId `"default"`, so the connection is labelled
 * "Connexion N" and shares one account key with every other connection on that
 * provider. A transcription slip here survives code review, type checking and
 * every offline test — the fixture suite pins each JSONPath against a
 * documented payload, but nothing pins the URL those paths are read from.
 *
 * What CAN be established without any credential is whether the URL is live and
 * auth-gated. A deliberately invalid bearer token must be REJECTED:
 *
 *   - `401` / `403` → the host answered and refused. That is as far as a
 *     credential-free check reaches, and it covers the part that rots: hosts
 *     get renamed, API versions get retired. `403` is deliberately read the
 *     same way as `401` even though it is ambiguous — Reddit returns it for a
 *     datacenter-IP block rather than for the token — because both readings
 *     agree on the only claim being made here: something is serving this path.
 *   - `404` / `405` / `410` → the path is wrong, or refuses a GET. The
 *     platform's identity fetch is a plain GET, so a 405 is as fatal as a 404.
 *   - `2xx` → alarming: something answering an invalid token with content is
 *     not the authenticated identity endpoint this manifest assumes.
 *
 * A network failure is a `warn`, never a `fail` — third-party reachability from
 * a CI runner is not the manifest's fault, and a check that reddens the run on
 * someone else's outage gets muted.
 *
 * What this does NOT establish: that the response BODY has the shape the
 * manifest's `identity_claims` read. That needs a real token. The offline
 * fixture suite (`system-package-identity-claims`) covers the shape against a
 * documented payload; this covers the URL. Neither replaces one real connect.
 */

import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import type { Finding } from "./types.ts";
import { ssrfGuardedFetch } from "./ssrf-fetch.ts";

const CHECK = "identity-endpoint";
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Token sent to be rejected. Deliberately not credential-shaped, so it cannot
 * be mistaken for a leaked secret in a log or a proxy trace.
 */
const INVALID_BEARER = "conformance-probe-not-a-real-token";

/** Statuses proving the endpoint exists and enforces authentication. */
const REJECTS_AUTH = new Set([401, 403]);
/** Statuses proving the path itself is wrong. */
const WRONG_PATH = new Set([404, 405, 410]);

interface DeclaredEndpoint {
  authKey: string;
  url: string;
}

/** Every `userinfo_endpoint` an integration manifest declares. */
export function declaredIdentityEndpoints(manifest: Record<string, unknown>): DeclaredEndpoint[] {
  const auths = manifest.auths;
  if (!auths || typeof auths !== "object") return [];
  return Object.entries(auths as Record<string, unknown>).flatMap(([authKey, auth]) => {
    if (!auth || typeof auth !== "object") return [];
    const url = (auth as { userinfo_endpoint?: unknown }).userinfo_endpoint;
    return typeof url === "string" && url.length > 0 ? [{ authKey, url }] : [];
  });
}

/**
 * Classify one probe response. Split out so the severity table is covered
 * without a network round-trip.
 */
export function classifyIdentityProbe(
  packageId: string,
  authKey: string,
  url: string,
  status: number,
): Finding {
  const where = `auth '${authKey}' → ${url}`;
  if (REJECTS_AUTH.has(status)) {
    return {
      packageId,
      check: CHECK,
      severity: "info",
      message: `${where}: live, request refused (HTTP ${status})`,
    };
  }
  if (WRONG_PATH.has(status)) {
    return {
      packageId,
      check: CHECK,
      severity: "fail",
      message: `${where}: HTTP ${status} — no identity endpoint at this URL (or it refuses GET), so every connection silently falls back to accountId "default"`,
    };
  }
  if (status >= 200 && status < 300) {
    return {
      packageId,
      check: CHECK,
      severity: "fail",
      message: `${where}: HTTP ${status} for a deliberately invalid token — this is not an authenticated identity endpoint`,
    };
  }
  return {
    packageId,
    check: CHECK,
    severity: "warn",
    message: `${where}: HTTP ${status} — inconclusive, neither an auth rejection nor a missing path`,
  };
}

/** Probe every declared identity endpoint on one package. */
export async function checkIdentityEndpoints(entry: SystemPackageEntry): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const { authKey, url } of declaredIdentityEndpoints(entry.manifest)) {
    let status: number;
    try {
      const res = await ssrfGuardedFetch(url, {
        headers: {
          Authorization: `Bearer ${INVALID_BEARER}`,
          Accept: "application/json",
          "User-Agent": "Appstrate",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      status = res.status;
    } catch (err) {
      findings.push({
        packageId: entry.packageId,
        check: CHECK,
        severity: "warn",
        message: `auth '${authKey}' → ${url}: unreachable from this runner (${String(err)}) — NOT verified`,
      });
      continue;
    }
    findings.push(classifyIdentityProbe(entry.packageId, authKey, url, status));
  }
  return findings;
}
