// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-free check of the API a credential-only integration calls — the
 * `auth-reject` half of every `AUTH_PROBES` entry.
 *
 * `auth-live` needs a real credential in `CONFORMANCE_TOKENS`, so without one
 * a probed package used to report nothing but "skipped". This check sends
 * three requests and compares them, because a 401 on its own proves very
 * little: most providers answer 401 whether or not the credential header was
 * sent, and several authenticate before routing, so a retired path answers
 * 401 too. Measured on the seeded probes before this was written.
 *
 *   A. probe URL + an invalid credential rendered through the manifest's own
 *      `delivery.http` (the runtime's resolver, byte-for-byte what a run sends)
 *   B. a sibling path that cannot exist + the same credential
 *   C. probe URL with the credential header left out
 *
 * A's status is read with the `identity-endpoint` table: 401/403 → live;
 * 404/405/410 → FAIL (API gone); 2xx → FAIL (invalid credential accepted);
 * anything else or a network error → WARN. When A is a rejection, two more
 * facts are established:
 *
 *   - **delivery**: A must differ from C (status + body, JSON compared with
 *     sorted keys). A provider that answers "invalid key" to A and "no key" to
 *     C has read the header the manifest declares. If they are identical it
 *     never saw it — a wrong header name or prefix in the manifest → FAIL,
 *     unless the probe records `sameResponseWithoutCredential` (the provider
 *     answers both alike; then it is reported as unconfirmable).
 *   - **path**: if B is 404/405/410 while A is 401/403, the probe path itself
 *     is verified. If B is also refused, the provider authenticates before
 *     routing and only the host is verified — said in the report, not implied.
 *
 * Skipped: a probe marked `rejectsInvalid: false` (a 200 with the error in the
 * body cannot be judged by status), and a probe URL that is also a declared
 * `userinfo_endpoint`, which `identity-endpoint` already sends an invalid token.
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

/** Appended to the probe path for request B — no API routes this. */
const CANARY_SUFFIX = "-appstrate-conformance-canary";

interface Observed {
  status: number;
  /** Status + body, JSON re-serialised with sorted keys so key order cannot differ. */
  fingerprint: string;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

async function observe(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<Observed> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = (await res.text()).trim();
  let body = text;
  try {
    body = JSON.stringify(sortKeys(JSON.parse(text)));
  } catch {
    // not JSON — compared as text
  }
  return { status: res.status, fingerprint: `${res.status}\n${body}` };
}

function canaryUrl(url: string): string {
  const u = new URL(url);
  u.pathname += CANARY_SUFFIX;
  return u.toString();
}

export async function checkAuthRejection(
  entry: SystemPackageEntry,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<Finding[]> {
  const probe = AUTH_PROBES[entry.packageId];
  if (!probe || probe.rejectsInvalid === false) return [];
  // Already probed the same way by `identity-endpoint` (github's whoami).
  if (declaredIdentityEndpoints(entry.manifest).some((e) => e.url === probe.url)) return [];

  const finding = (severity: Finding["severity"], message: string): Finding[] => [
    { packageId: entry.packageId, check: CHECK, severity, message: `${probe.url}: ${message}` },
  ];

  const authKey = probe.authKey ?? firstAuthKey(entry.manifest);
  const request = authKey ? applyAuth(probe.url, entry.manifest, INVALID_BEARER, authKey) : null;
  if (!request)
    return finding("fail", "the manifest declares no HTTP credential delivery to probe with");

  const bare = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => name !== request.credentialHeader),
  );
  const fetchImpl = opts.fetchImpl ?? ssrfGuardedFetch;
  let a: Observed, b: Observed, c: Observed;
  try {
    [a, b, c] = await Promise.all([
      observe(fetchImpl, request.url, request.headers),
      observe(fetchImpl, canaryUrl(request.url), request.headers),
      observe(fetchImpl, request.url, bare),
    ]);
  } catch (err) {
    return finding("warn", `unreachable from this runner (${String(err)}) — NOT verified`);
  }

  if (WRONG_PATH.has(a.status)) {
    return finding("fail", `HTTP ${a.status} — the probed API is gone (host or version retired?)`);
  }
  if (a.status >= 200 && a.status < 300) {
    return finding(
      "fail",
      `HTTP ${a.status} for a deliberately invalid credential — not an authenticated endpoint`,
    );
  }
  if (!REJECTS_AUTH.has(a.status)) {
    return finding(
      "warn",
      `HTTP ${a.status} — inconclusive, neither an auth rejection nor a missing path`,
    );
  }

  const header = request.credentialHeader;
  let delivery: string;
  if (a.fingerprint !== c.fingerprint) {
    delivery = `\`${header}\` read by the provider (answer differs from no credential)`;
  } else if (probe.sameResponseWithoutCredential) {
    delivery = `\`${header}\` unconfirmable (provider answers alike without a credential)`;
  } else {
    return finding(
      "fail",
      `HTTP ${a.status}, but the response is identical to a request with no credential — the provider never read the \`${header}\` header the manifest delivers (wrong header name or prefix?)`,
    );
  }
  const path = WRONG_PATH.has(b.status)
    ? "path verified (a sibling path answers " + b.status + ")"
    : `host only — the provider authenticates before routing (a sibling path answers ${b.status}), so a retired path would not show`;
  return finding(
    "info",
    `live, invalid credential refused (HTTP ${a.status}); ${delivery}; ${path}`,
  );
}
