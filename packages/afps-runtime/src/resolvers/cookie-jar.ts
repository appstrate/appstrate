// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

// Sticky-cookie jar of both credential proxies; rules: SIDECAR.md "Sticky-cookie jar scoping".

import { hostLiterallyAllowlisted } from "./http-call-core.ts";

/** Bucket key -> cookie pairs (`name=value`, attributes stripped). */
export type CookieJar = Map<string, string[]>;

/** One integration's view of a {@link CookieJar} under one call's URL policy. */
export interface CookieScope {
  /** One Cookie header for `url` (undefined when empty). By name: literal-allowlist sibling
   *  origins < `base` (injected credential / caller cookies) < `url`'s own origin. */
  header(url: string, base: string | null | undefined): string | undefined;
  /** Merge `url`'s Set-Cookie into its own bucket; an expired cookie deletes the name. */
  capture(url: string, setCookieHeaders: string[]): void;
}

type Gate = "allowlist" | "open";

// NUL occurs in neither a package id nor an origin, so keys cannot collide.
const SEP = "\u0000";

/** RFC 6265 §6.1's per-domain floor; bounds a bucket an upstream minting per-request names grows. */
const MAX_COOKIES_PER_ORIGIN = 50;

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

/** RFC 6265 §5.2.1–5.2.2: Max-Age takes precedence over Expires. */
function isDeletion(attributes: string[]): boolean {
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
  return expires !== undefined && expires <= Date.now();
}

/** `literalAllowlist`: the call's authorized_uris when they gated it, null under allow_all_uris
 *  or without an allowlist. Only hosts it names literally share cookies across origins. */
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
      const origin = originOf(url);
      const byName = new Map<string, string>();
      if (gate(url) === "allowlist") {
        const siblings = key("allowlist", "");
        for (const [k, pairs] of jar) {
          if (k.startsWith(siblings) && k !== key("allowlist", origin)) fold(byName, pairs);
        }
      }
      fold(byName, base?.split(";") ?? []);
      fold(byName, jar.get(key("open", origin)) ?? []);
      fold(byName, jar.get(key("allowlist", origin)) ?? []);
      return byName.size ? [...byName.values()].join("; ") : undefined;
    },

    capture(url, setCookieHeaders) {
      if (!setCookieHeaders.length) return;
      const k = key(gate(url), originOf(url));
      const byName = new Map<string, string>();
      fold(byName, jar.get(k) ?? []);
      for (const header of setCookieHeaders) {
        const [pair = "", ...attributes] = header.split(";");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq).trim();
        if (eq < 0 || !name) continue;
        byName.delete(name); // re-set moves the name to the newest position
        if (!isDeletion(attributes)) byName.set(name, `${name}=${pair.slice(eq + 1).trim()}`);
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
