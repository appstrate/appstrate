// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Sticky-cookie jar shared by the credential proxies (the sidecar's
 * `executeApiCall` and the platform's `/api/credential-proxy/proxy`) and the
 * redirect follower in `api-call-engine.ts`.
 *
 * A jar maps a bucket key to cookie pairs (`name=value`, attributes
 * stripped). Buckets are keyed by {@link cookieBucketKey}; which buckets a
 * call may read is decided by {@link eligibleCookies}.
 */

/** Bucket key -> cookie pairs (`name=value`, attributes stripped). */
export type CookieJar = Map<string, string[]>;

/**
 * Which URL policy admitted the call that captured (or is about to replay) a
 * cookie.
 *
 * `allowlist` — the integration's `authorized_uris` gated it AND some entry
 * names this exact host with a wildcard-free host segment
 * (`hostLiterallyAllowlisted`). Matching an entry is not enough: the AFPS glob
 * grammar lets `*`/`**` span the host (`https://**`,
 * `https://*.myshopify.com/**`), and then the concrete host was picked by the
 * AGENT at call time, not written down by the operator.
 *
 * `open` — everything else: `allow_all_uris`, no allowlist at all, or an
 * allowlist matched only through a glob host. The SSRF floor is not a trust
 * boundary, it only excludes internals.
 */
export type CookieGate = "allowlist" | "open";

/**
 * Separator for {@link cookieBucketKey}. NUL cannot occur in a package id nor
 * in a WHATWG origin, so the three parts of a key are unambiguous and no
 * integration id can be crafted to forge another's bucket.
 */
const COOKIE_KEY_SEP = "\u0000";

/**
 * Key of one bucket in a run-wide cookie jar: `(integration, gate, capture
 * origin)`. Cookie attributes (Domain, Path, …) are stripped on capture, so
 * without the origin nothing would record WHERE a cookie came from, and under
 * `allow_all_uris` a live session cookie would ship to whatever host the
 * model names. A replayed cookie carries no `{{field}}` template, so the
 * credential-exfiltration guard never sees it.
 *
 *   - `origin` — WHATWG origin of the call's INITIAL, policy-checked target.
 *     A whole redirect chain shares one bucket on purpose (#473): the session
 *     cookie of an OAuth/CAS flow lands on an intermediate hop and must serve
 *     the next call to the origin that started the flow. The redirect
 *     follower strips cookies on an out-of-boundary cross-origin hop.
 *   - `gate` — see {@link CookieGate}. Recorded at capture time so
 *     {@link eligibleCookies} can tell an allowlist-gated bucket from an
 *     `allow_all_uris` one without re-deriving the policy.
 */
export function cookieBucketKey(integrationId: string, gate: CookieGate, origin: string): string {
  return `${integrationId}${COOKIE_KEY_SEP}${gate}${COOKIE_KEY_SEP}${origin}`;
}

/** WHATWG origin of `url`, or `"null"` (the opaque origin) when unparseable. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

function cookieName(pair: string): string {
  return pair.split("=")[0]!.trim();
}

/**
 * Cookies the jar may attach to a call for `targetOrigin`, keyed by cookie
 * name (the caller may overlay fresher entries on the returned map).
 *
 * Two admission rules, and only two:
 *   - Same origin as capture — always. That IS sticky-session continuity.
 *   - Different origin — only when BOTH the capturing call and this call
 *     landed on a host the operator wrote down LITERALLY in `authorized_uris`
 *     (`gate === "allowlist"`). That is the declared multi-host case (Dropbox
 *     `api ⇄ content`) and matches the redirect follower's hybrid credential
 *     strip. Two hosts that only share a glob (`victim.myshopify.com`,
 *     `attacker.myshopify.com`) are two tenants, not one trust boundary.
 *
 * Same-origin buckets are folded in LAST so a fresh same-origin value wins
 * over a stale sibling-host one of the same name.
 */
export function eligibleCookies(
  jar: CookieJar,
  integrationId: string,
  gate: CookieGate,
  targetOrigin: string,
): Map<string, string> {
  const byName = new Map<string, string>();
  const fold = (cookies: readonly string[] | undefined) => {
    for (const ck of cookies ?? []) byName.set(cookieName(ck), ck);
  };
  if (gate === "allowlist") {
    const prefix = `${integrationId}${COOKIE_KEY_SEP}allowlist${COOKIE_KEY_SEP}`;
    for (const [key, cookies] of jar) {
      if (key.startsWith(prefix)) fold(cookies);
    }
  }
  fold(jar.get(cookieBucketKey(integrationId, "open", targetOrigin)));
  fold(jar.get(cookieBucketKey(integrationId, "allowlist", targetOrigin)));
  return byName;
}

/** True when the Set-Cookie attributes expire the cookie (RFC 6265 §5.2.1–5.2.2). */
function isDeletion(attributes: string[], now: number): boolean {
  let maxAge: number | undefined;
  let expires: number | undefined;
  for (const attr of attributes) {
    const eq = attr.indexOf("=");
    if (eq < 0) continue;
    const name = attr.slice(0, eq).trim().toLowerCase();
    const value = attr.slice(eq + 1).trim();
    if (name === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value);
    else if (name === "expires") {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) expires = t;
    }
  }
  if (maxAge !== undefined) return maxAge <= 0;
  return expires !== undefined && expires <= now;
}

/**
 * Merge `Set-Cookie` values into `jar[key]`, deduped by cookie name,
 * attributes stripped. A cookie expired by `Max-Age <= 0` or a past `Expires`
 * (Max-Age takes precedence) is REMOVED from the bucket; an emptied bucket is
 * dropped. Future expiry is not tracked — jars are short-lived.
 */
export function mergeSetCookieIntoJar(
  setCookieHeaders: string[],
  jar: CookieJar,
  key: string,
  now: number = Date.now(),
): void {
  if (!setCookieHeaders.length) return;
  const byName = new Map<string, string>();
  for (const ck of jar.get(key) ?? []) byName.set(cookieName(ck), ck);
  for (const header of setCookieHeaders) {
    const [pair = "", ...attributes] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    if (isDeletion(attributes, now)) byName.delete(name);
    else byName.set(name, `${name}=${pair.slice(eq + 1).trim()}`);
  }
  if (byName.size) jar.set(key, [...byName.values()]);
  else jar.delete(key);
}

/** Parse a `Cookie:` header value into name→pair entries, deduped by name. */
function parseCookieHeader(value: string | null | undefined): Map<string, string> {
  const byName = new Map<string, string>();
  for (const part of value?.split(";") ?? []) {
    const pair = part.trim();
    if (pair) byName.set(cookieName(pair), pair);
  }
  return byName;
}

/**
 * One `Cookie` header value: the pairs of `base` (an existing header —
 * injected credential and/or caller-supplied) with `overlay` pairs winning by
 * name. `undefined` when there is no pair at all.
 */
export function composeCookieHeader(
  base: string | null | undefined,
  overlay: Iterable<string>,
): string | undefined {
  const byName = parseCookieHeader(base);
  for (const ck of overlay) {
    const pair = ck.trim();
    if (pair) byName.set(cookieName(pair), pair);
  }
  return byName.size ? [...byName.values()].join("; ") : undefined;
}
