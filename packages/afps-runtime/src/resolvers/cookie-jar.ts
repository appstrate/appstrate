// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

// Sticky-cookie jar of both credential proxies; rules: SIDECAR.md "Sticky-cookie jar scoping".

import { hostLiterallyAllowlisted } from "./http-call-core.ts";

/** One stored cookie: `name=value` (attributes stripped) and its RFC 6265 §5.3 expiry
 *  (epoch ms; absent = session cookie, kept for the jar's lifetime). */
export interface StoredCookie {
  pair: string;
  expiresAt?: number;
}

/** Bucket key -> stored cookies. */
export type CookieJar = Map<string, StoredCookie[]>;

/** One integration's view of a {@link CookieJar} under one call's URL policy. */
export interface CookieScope {
  /** One Cookie header for `url` (undefined when empty), expired cookies excluded. By name:
   *  literal-allowlist sibling origins < `base` (injected credential / caller cookies) < `url`'s
   *  own origin. A cookie captured over https never reaches a non-https `url`. */
  header(url: string, base: string | null | undefined): string | undefined;
  /** Merge `url`'s Set-Cookie into its own bucket, storing each expiry and purging expired
   *  entries; an already-expired cookie deletes the name. */
  capture(url: string, setCookieHeaders: string[]): void;
}

type Gate = "allowlist" | "open";

// NUL occurs in neither a package id nor an origin, so keys cannot collide.
const SEP = "\u0000";

/** RFC 6265 §6.1's per-domain floor; bounds a bucket an upstream minting per-request names grows. */
const MAX_COOKIES_PER_ORIGIN = 50;

/** RFC 6265bis §5.6.2 caps Max-Age at 400 days (also keeps the expiry finite, hence JSON-safe). */
const MAX_AGE_SECONDS = 400 * 86_400;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

function fold(byName: Map<string, string>, pairs: Iterable<string>): void {
  for (const raw of pairs) {
    const pair = raw.trim();
    if (pair) byName.set(pair.split("=")[0]!.trim(), pair);
  }
}

const alive = (c: StoredCookie, now: number) => c.expiresAt === undefined || c.expiresAt > now;

/** Pairs of `entries` not expired at `now` (RFC 6265 §5.4 step 1). */
function* live(entries: readonly StoredCookie[] | undefined, now: number): Iterable<string> {
  for (const c of entries ?? []) if (alive(c, now)) yield c.pair;
}

/** RFC 6265 §5.2.1–5.2.2: absolute expiry; a valid Max-Age takes precedence over Expires. */
function expiryOf(attributes: string[], now: number): number | undefined {
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
  return maxAge !== undefined ? now + Math.min(maxAge, MAX_AGE_SECONDS) * 1000 : expires;
}

/** `literalAllowlist`: the DECLARED (unrendered) authorized_uris when an allowlist gated the call,
 *  null under allow_all_uris or without one. Only hosts it names literally share cookies across origins. */
export function cookieScope(
  jar: CookieJar,
  integrationId: string,
  literalAllowlist: readonly string[] | null,
): CookieScope {
  const gate = (url: string): Gate =>
    literalAllowlist && hostLiterallyAllowlisted(url, literalAllowlist) ? "allowlist" : "open";
  const key = (g: Gate, origin: string) => `${integrationId}${SEP}${g}${SEP}${origin}`;

  return {
    header(url, base) {
      const now = Date.now();
      const origin = originOf(url);
      const byName = new Map<string, string>();
      if (gate(url) === "allowlist") {
        const siblings = key("allowlist", "");
        const secure = origin.startsWith("https:");
        for (const [k, entries] of jar) {
          if (!k.startsWith(siblings) || k === key("allowlist", origin)) continue;
          // RFC 6265 `Secure` for every https-captured cookie (`Secure` itself is not stored).
          if (!secure && k.slice(siblings.length).startsWith("https:")) continue;
          fold(byName, live(entries, now));
        }
      }
      fold(byName, base?.split(";") ?? []);
      fold(byName, live(jar.get(key("open", origin)), now));
      fold(byName, live(jar.get(key("allowlist", origin)), now));
      return byName.size ? [...byName.values()].join("; ") : undefined;
    },

    capture(url, setCookieHeaders) {
      if (!setCookieHeaders.length) return;
      const now = Date.now();
      const k = key(gate(url), originOf(url));
      const byName = new Map<string, StoredCookie>();
      for (const c of jar.get(k) ?? []) if (alive(c, now)) byName.set(c.pair.split("=")[0]!, c);
      for (const header of setCookieHeaders) {
        const [pair = "", ...attributes] = header.split(";");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq).trim();
        if (eq < 0 || !name) continue;
        byName.delete(name); // re-set moves the name to the newest position
        const stored: StoredCookie = {
          pair: `${name}=${pair.slice(eq + 1).trim()}`,
          expiresAt: expiryOf(attributes, now),
        };
        if (alive(stored, now)) byName.set(name, stored);
      }
      for (const name of byName.keys()) {
        if (byName.size <= MAX_COOKIES_PER_ORIGIN) break;
        byName.delete(name); // least recently set first
      }
      if (byName.size) jar.set(k, [...byName.values()]);
      else jar.delete(k);
    },
  };
}
