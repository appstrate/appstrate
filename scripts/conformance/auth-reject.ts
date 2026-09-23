// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-free liveness check for the API a credential-only integration
 * calls — the `auth-reject` half of every `AUTH_PROBES` entry.
 *
 * `auth-live` needs a real credential in `CONFORMANCE_TOKENS`, so without one
 * a probed package used to report nothing but "skipped": a provider could
 * retire the API version or rename the host and the monitor stayed green.
 * This check sends the probe endpoint a deliberately invalid credential,
 * rendered through the manifest's own `delivery.http` (same resolver as a real
 * run), and reads the status with the same table as `identity-endpoint`:
 *
 *   - `401` / `403` → the host answered and refused → INFO
 *   - `404` / `405` / `410` → the path is gone → FAIL
 *   - `2xx` → an invalid credential was accepted: not the authenticated
 *     endpoint the probe assumes → FAIL
 *   - anything else → WARN (inconclusive); network failure → WARN
 *
 * Skipped: a probe marked `rejectsInvalid: false` (a provider answering 200
 * with the error in the body — a status-only reading cannot judge it), and a
 * probe URL that is also a declared `userinfo_endpoint`, which
 * `identity-endpoint` already sends the same invalid token.
 */

import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import type { Finding } from "./types.ts";
import { AUTH_PROBES } from "./probes.ts";
import { applyAuth, firstAuthKey } from "./auth-live.ts";
import { ssrfGuardedFetch } from "./ssrf-fetch.ts";
import {
  declaredIdentityEndpoints,
  FETCH_TIMEOUT_MS,
  INVALID_BEARER,
  REJECTS_AUTH,
  WRONG_PATH,
} from "./identity-endpoint.ts";

const CHECK = "auth-reject";

/** Classify one response to the invalid credential. */
function classifyRejection(packageId: string, url: string, status: number): Finding {
  const finding = (severity: Finding["severity"], message: string): Finding => ({
    packageId,
    check: CHECK,
    severity,
    message: `${url}: ${message}`,
  });
  if (REJECTS_AUTH.has(status))
    return finding("info", `live, invalid credential refused (HTTP ${status})`);
  if (WRONG_PATH.has(status)) {
    return finding("fail", `HTTP ${status} — the probed API is gone (host or version retired?)`);
  }
  if (status >= 200 && status < 300) {
    return finding(
      "fail",
      `HTTP ${status} for a deliberately invalid credential — not an authenticated endpoint`,
    );
  }
  return finding(
    "warn",
    `HTTP ${status} — inconclusive, neither an auth rejection nor a missing path`,
  );
}

export async function checkAuthRejection(
  entry: SystemPackageEntry,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<Finding[]> {
  const probe = AUTH_PROBES[entry.packageId];
  if (!probe || probe.rejectsInvalid === false) return [];
  // Already probed the same way by `identity-endpoint` (github's whoami).
  if (declaredIdentityEndpoints(entry.manifest).some((e) => e.url === probe.url)) return [];

  const authKey = probe.authKey ?? firstAuthKey(entry.manifest);
  const request = authKey ? applyAuth(probe.url, entry.manifest, INVALID_BEARER, authKey) : null;
  if (!request) {
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "fail",
        message: `${probe.url}: the manifest declares no HTTP credential delivery to probe with`,
      },
    ];
  }

  const fetchImpl = opts.fetchImpl ?? ssrfGuardedFetch;
  try {
    const res = await fetchImpl(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return [classifyRejection(entry.packageId, probe.url, res.status)];
  } catch (err) {
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "warn",
        message: `${probe.url}: unreachable from this runner (${String(err)}) — NOT verified`,
      },
    ];
  }
}
