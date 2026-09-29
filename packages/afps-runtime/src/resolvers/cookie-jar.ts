// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Sticky-cookie jar shared by the sidecar and platform credential proxies and
 * the redirect follower. Scoping rules and rationale: `docs/architecture/
 * SIDECAR.md`, "Sticky-cookie jar scoping".
 */

import { hostLiterallyAllowlisted } from "./http-call-core.ts";

/** Bucket key -> cookie pairs (`name=value`, attributes stripped). */
export type CookieJar = Map<string, string[]>;

/** One integration's view of a {@link CookieJar} under one call's URL policy. */
export interface CookieScope {
  /** One Cookie header value for a request to `url`, or undefined when empty.
   *  Precedence by name: sibling-origin cookies (literal-allowlist buckets of OTHER origins)
   *  < `base` (injected credential / caller cookies) < `url`'s own-origin cookies. */
  header(url: string, base: string | null | undefined): string | undefined;
  /** Merge Set-Cookie values received from `url` into `url`'s own bucket (attributes stripped;
   *  Max-Age<=0 / past Expires removes the name; an emptied bucket is dropped). */
  capture(url: string, setCookieHeaders: string[]): void;
}

type Gate = "allowlist" | "open";

// NUL occurs in neither a package id nor an origin, so keys cannot collide.
const SEP = "\u0000";

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

/** Fold `name=value` pairs into `byName`; a later pair wins by name. */
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

/** `literalAllowlist`: the authorized_uris to test with hostLiterallyAllowlisted, or null when the
 *  call's policy is open (allow_all_uris, no allowlist, credential-substitution downgrade …). */
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
        if (isDeletion(attributes)) byName.delete(name);
        else byName.set(name, `${name}=${pair.slice(eq + 1).trim()}`);
      }
      if (byName.size) jar.set(k, [...byName.values()]);
      else jar.delete(k);
    },
  };
}
