// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  compileEgressPolicy,
  hostLiterallyAllowlisted,
  isHostUnboundedUriPattern,
  matchesAuthorizedUriSpec,
  parseAuthorizedUriPattern,
  parseUrlFormPattern,
  renderAuthorizedUris,
  unrenderableAuthorizedUriFields,
} from "../src/authorized-uris.ts";

describe("renderAuthorizedUris", () => {
  const ssh = "ssh://{$credential.host}:{$credential.port}";

  it("passes untemplated patterns unchanged", () => {
    const patterns = ["https://api.example.com/**", "ssh://**"];
    expect(renderAuthorizedUris(patterns, {})).toEqual(patterns);
  });

  it("renders host and port", () => {
    expect(renderAuthorizedUris([ssh], { host: "box.example.com", port: "2222" })).toEqual([
      "ssh://box.example.com:2222",
    ]);
  });

  it("allows uppercase hosts and dotted runs", () => {
    expect(renderAuthorizedUris([ssh], { host: "Box..Example.COM", port: "22" })).toEqual([
      "ssh://Box..Example.COM:22",
    ]);
  });

  it("drops a pattern whose field is missing", () => {
    expect(renderAuthorizedUris([ssh], { host: "box.example.com" })).toEqual([]);
  });

  it("drops a pattern whose field is empty", () => {
    expect(renderAuthorizedUris([ssh], { host: "box.example.com", port: "" })).toEqual([]);
  });

  it("does not read inherited properties", () => {
    expect(renderAuthorizedUris(["ssh://{$credential.constructor}"], {})).toEqual([]);
  });

  for (const bad of [
    "*",
    "evil.com/x",
    "evil.com:1",
    "user@evil.com",
    "a b",
    "a?b",
    "a#b",
    "**",
    ".",
    "..",
  ]) {
    it(`drops a pattern whose value is ${JSON.stringify(bad)}`, () => {
      expect(renderAuthorizedUris([ssh], { host: bad, port: "22" })).toEqual([]);
    });
  }

  it("drops a dot-only value that would widen a path", () => {
    const tenant = "https://api.example.com/tenants/{$credential.t}/**";
    expect(renderAuthorizedUris([tenant], { t: ".." })).toEqual([]);
    expect(renderAuthorizedUris([tenant], { t: "." })).toEqual([]);
  });

  it("keeps static entries and drops only the unrenderable templated ones", () => {
    const patterns = [
      "https://static.example.com/**",
      "https://{$credential.tenant}.example.com/**",
      ssh,
    ];
    expect(renderAuthorizedUris(patterns, { tenant: "acme", host: "*", port: "22" })).toEqual([
      "https://static.example.com/**",
      "https://acme.example.com/**",
    ]);
  });

  it("returns [] (deny-all) when nothing renders", () => {
    expect(renderAuthorizedUris([ssh], {})).toEqual([]);
  });
});

describe("parseUrlFormPattern", () => {
  it("splits a leading placeholder from its / suffix", () => {
    expect(parseUrlFormPattern("{$credential.site_url}/api/3/**")).toEqual({
      field: "site_url",
      suffix: "/api/3/**",
    });
    expect(parseUrlFormPattern("{$credential.webhook_url}")).toEqual({
      field: "webhook_url",
      suffix: "",
    });
  });

  for (const pattern of [
    "https://{$credential.host}/**",
    "x{$credential.site_url}/**",
    "{$credential.site_url}.example.com/**",
    "{$credential.site_url}{$credential.path}",
    "{$credential.site_url}/{$credential.path}",
    "https://api.example.com/**",
  ]) {
    it(`is null for ${JSON.stringify(pattern)}`, () => {
      expect(parseUrlFormPattern(pattern)).toBeNull();
    });
  }
});

describe("renderAuthorizedUris — URL form", () => {
  const site = "{$credential.site_url}/**";

  for (const [value, expected] of [
    ["https://shop.example.com", "https://shop.example.com/**"],
    ["https://shop.example.com/", "https://shop.example.com/**"],
    ["https://shop.example.com/blog/", "https://shop.example.com/blog/**"],
    ["http://shop.example.com:8080/blog", "http://shop.example.com:8080/blog/**"],
    ["https://Shop.Example.com:443", "https://shop.example.com/**"],
  ] as const) {
    it(`renders ${JSON.stringify(value)}`, () => {
      expect(renderAuthorizedUris([site], { site_url: value })).toEqual([expected]);
    });
  }

  it("renders a bare placeholder as the exact URL and appends a longer suffix", () => {
    const fields = { url: "https://hooks.example.com/services/T1/B2/" };
    // Exact: a call to the stored URL (trailing `/` included) must match its own entry.
    expect(renderAuthorizedUris(["{$credential.url}"], fields)).toEqual([
      "https://hooks.example.com/services/T1/B2/",
    ]);
    expect(
      renderAuthorizedUris(["{$credential.url}"], { url: "https://hooks.example.com" }),
    ).toEqual(["https://hooks.example.com"]);
    expect(renderAuthorizedUris(["{$credential.url}/api/3/**"], fields)).toEqual([
      "https://hooks.example.com/services/T1/B2/api/3/**",
    ]);
  });

  for (const bad of [
    "mysite.com",
    "ftp://shop.example.com",
    "https://user:pass@shop.example.com",
    "https://user@shop.example.com",
    "https://shop.example.com/?a=1",
    "https://shop.example.com/#x",
    "https://shop.example.com/?",
    "https://shop.example.com/#",
    "https://*.example.com",
    "https://shop.example.com/*",
    "",
  ]) {
    it(`drops the entry when the value is ${JSON.stringify(bad)}`, () => {
      expect(renderAuthorizedUris([site], { site_url: bad })).toEqual([]);
    });
  }

  it("drops the entry when the field is missing or inherited", () => {
    expect(renderAuthorizedUris([site], {})).toEqual([]);
    expect(renderAuthorizedUris(["{$credential.constructor}/**"], {})).toEqual([]);
  });

  it("keeps the query of a bare entry (Google Chat, Power Automate webhooks)", () => {
    const hook = "https://chat.googleapis.com/v1/spaces/S/messages?key=k&token=t";
    expect(renderAuthorizedUris(["{$credential.url}"], { url: hook })).toEqual([hook]);
    expect(
      renderAuthorizedUris(["{$credential.url}"], { url: "https://flow.example.com?sig=s" }),
    ).toEqual(["https://flow.example.com/?sig=s"]);
  });

  for (const bad of [
    "https://flow.example.com/hook?sig=s#x",
    "https://u@flow.example.com/hook?sig=s",
    "https://flow.example.com/hook?sig=*",
    // Rendered without the `?` / `#`, while a call to the stored URL keeps it: never a match.
    "https://flow.example.com/hook?",
    "https://flow.example.com/hook#",
    "https://flow.example.com/hook?#",
  ]) {
    it(`drops a bare entry whose value is ${JSON.stringify(bad)}`, () => {
      expect(renderAuthorizedUris(["{$credential.url}"], { url: bad })).toEqual([]);
    });
  }
});

describe("unrenderableAuthorizedUriFields", () => {
  const patterns = [
    "https://static.example.com/**",
    "{$credential.site_url}/**",
    "{$credential.site_url}/wp-json/**",
    "{$credential.hook}",
    "ssh://{$credential.host}:{$credential.port}",
  ];

  it("is empty when every templated entry renders", () => {
    const fields = {
      site_url: "https://shop.example.com",
      hook: "https://hooks.example.com/x?key=k",
      host: "box.example.com",
      port: "22",
    };
    expect(unrenderableAuthorizedUriFields(patterns, fields)).toEqual([]);
  });

  it("names each offending field once, with the form it must take", () => {
    const fields = {
      site_url: "mysite.com",
      hook: "https://h.example.com#x",
      host: "a/b",
      port: 22,
    };
    expect(unrenderableAuthorizedUriFields(patterns, fields).map((f) => f.field)).toEqual([
      "site_url",
      "hook",
      "host",
    ]);
    const [site, hook, host] = unrenderableAuthorizedUriFields(patterns, fields);
    expect(site!.expected).toContain("query string");
    expect(hook!.expected).not.toContain("query string");
    expect(host!.expected).toContain("host name");
  });

  it("names a bare entry whose value ends in an empty '?' or '#'", () => {
    for (const hook of ["https://h.example.com/hook?", "https://h.example.com/hook#"]) {
      const [entry] = unrenderableAuthorizedUriFields(["{$credential.hook}"], { hook });
      expect(entry).toEqual({ field: "hook", expected: expect.stringContaining("empty '?'") });
    }
  });

  it("never echoes the value", () => {
    const [entry] = unrenderableAuthorizedUriFields(["{$credential.u}/**"], { u: "sk-secret" });
    expect(JSON.stringify(entry)).not.toContain("sk-secret");
  });

  it("ignores untemplated patterns", () => {
    expect(unrenderableAuthorizedUriFields(["https://api.example.com/**"], {})).toEqual([]);
  });
});

describe("isHostUnboundedUriPattern", () => {
  it("is false when the entry names its host, a subdomain glob included", () => {
    for (const pattern of [
      "https://api.example.com/**",
      "https://*.example.com/**",
      "https://api-*.example.com:*/v1/*",
      "https://*.example.com./**",
      "http://[::1]:8080/**",
      "https://10.0.0.1/**",
      "https://*.example.0xg/**",
      "https://{$credential.subdomain}.zendesk.com/**",
      "https://{$credential.host}/**",
      "{$credential.site_url}/**",
      "{$credential.webhook_url}",
      "api.example.com/path",
    ]) {
      expect([pattern, isHostUnboundedUriPattern(pattern)]).toEqual([pattern, false]);
    }
  });

  it("is true when the caller picks the registrable host", () => {
    for (const pattern of [
      "https://**",
      "https://**/health",
      "*://**",
      "https://*",
      "https://*.com/**",
      "https://api*.io/**",
      "https://example.*/**",
      "https://*.*/**",
      "https://user@*/**",
      "https://*:443/",
      "https://{$credential.name}.*/**",
      "**",
      "*/**",
      "**://api.example.com/**",
      "*://api.example.com/**",
      "https:///**",
      "https://user@/**",
      "https://*.com./**",
      "https://*.com../**",
      "https://[::**/**",
      "https://[2001:db8::*]/**",
      "https://[::ffff:*.2.3.4]/**",
      "https://*.0.1/**",
      "https://*.168.1.1/**",
      "https://*.example.0x1/**",
      "https://*.example.0x/**",
    ]) {
      expect([pattern, isHostUnboundedUriPattern(pattern)]).toEqual([pattern, true]);
    }
  });

  it("is true for a malformed entry, whose authority WHATWG would rewrite", () => {
    for (const pattern of [
      "https://%2A%2A\\**",
      "https://@x:y@**/**",
      "https://u@x:1@**/**",
      "https://api.example.com@evil.test/**",
      "https://api%2Eexample.com/**",
      "https://api.example.com\\@evil.test/**",
      "https://api.exa mple.com/**",
      "https://api.example.com\t/**",
      "https://ａpi.example.com/**",
      "https://api.example.com?x/**",
      "https:///api.example.com/x",
      "https://127.1/**",
    ]) {
      expect([pattern, isHostUnboundedUriPattern(pattern)]).toEqual([pattern, true]);
    }
  });
});

describe("parseAuthorizedUriPattern", () => {
  it("canonicalises scheme, host case and a default port, keeping the wildcards", () => {
    expect(parseAuthorizedUriPattern("HTTPS://*.Example.COM:443/v1/**")).toEqual({
      kind: "url",
      scheme: "https://",
      authority: "*.example.com",
      host: "*.example.com",
      rest: "/v1/**",
    });
  });

  it("keeps the raw authority of a pattern WHATWG cannot parse", () => {
    expect(parseAuthorizedUriPattern("https://h.example.com:*/**")).toEqual({
      kind: "url",
      scheme: "https://",
      authority: "h.example.com:*",
      host: "h.example.com",
      rest: "/**",
    });
    expect(parseAuthorizedUriPattern("http://[::1]:8080/x").kind).toBe("url");
  });

  it("tells a catch-all and a scheme-less pattern apart", () => {
    expect(parseAuthorizedUriPattern("*://**")).toEqual({ kind: "any", scheme: "*://" });
    expect(parseAuthorizedUriPattern("api.example.com/**")).toEqual({
      kind: "path",
      pattern: "api.example.com/**",
    });
  });

  it("refuses an authority that is empty, not canonical, or holds userinfo or escapes", () => {
    for (const pattern of [
      "https:///**",
      "https://%2A%2A\\**",
      "https://@x:y@**/**",
      "https://a.com%2f.evil.test/**",
      "https://a.com#.b.com/**",
      "https://0x7f.1/**",
    ]) {
      expect([pattern, parseAuthorizedUriPattern(pattern).kind]).toEqual([pattern, "malformed"]);
    }
  });
});

describe("matchesAuthorizedUriSpec", () => {
  it("** matches any path suffix including multi-segment and query", () => {
    const pat = "https://gmail.googleapis.com/**";
    expect(matchesAuthorizedUriSpec(pat, "https://gmail.googleapis.com/")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://gmail.googleapis.com/v1")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://gmail.googleapis.com/gmail/v1/users/me")).toBe(
      true,
    );
    expect(
      matchesAuthorizedUriSpec(
        pat,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
      ),
    ).toBe(true);
  });

  it("* matches a single path segment only — does not cross slashes", () => {
    const pat = "https://api.acme.com/*";
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/users")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/users/42")).toBe(false);
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/")).toBe(true);
  });

  it("`*` in mid-path matches a single segment only", () => {
    expect(
      matchesAuthorizedUriSpec(
        "https://api.example.com/v1/*/messages",
        "https://api.example.com/v1/abc/messages",
      ),
    ).toBe(true);
    expect(
      matchesAuthorizedUriSpec(
        "https://api.example.com/v1/*/messages",
        "https://api.example.com/v1/a/b/messages",
      ),
    ).toBe(false);
  });

  it("`**` in mid-path matches any substring including slashes", () => {
    expect(
      matchesAuthorizedUriSpec(
        "https://api.example.com/v1/**/messages",
        "https://api.example.com/v1/a/b/c/messages",
      ),
    ).toBe(true);
  });

  it("anchors the pattern — prefix-only matches are rejected", () => {
    expect(
      matchesAuthorizedUriSpec(
        "https://api.acme.com/**",
        "https://evil.com/?x=https://api.acme.com/anything",
      ),
    ).toBe(false);
  });

  it("escapes regex metacharacters in the pattern so they cannot inject", () => {
    expect(matchesAuthorizedUriSpec("https://api.acme.com/x.y", "https://apiXacmeXcom/xXy")).toBe(
      false,
    );
    expect(matchesAuthorizedUriSpec("https://api.acme.com/x.y", "https://api.acme.com/x.y")).toBe(
      true,
    );
  });

  it("subdomain wildcards stay single-segment and reject host smuggling", () => {
    const pat = "https://*.acme.com/**";
    expect(matchesAuthorizedUriSpec(pat, "https://eu.acme.com/v1/users/42")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://evil.com/x.acme.com/y")).toBe(false);
  });

  it("host `**` does not cross the authority boundary into the path", () => {
    const pat = "https://**.example.com/**";
    // Legitimate host matches.
    expect(matchesAuthorizedUriSpec(pat, "https://api.example.com/x")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://a.b.example.com/x/y")).toBe(true);
    // Authority-boundary bypass: the real host is evil.com; the pattern
    // must NOT let a path segment masquerade as the host.
    expect(matchesAuthorizedUriSpec(pat, "https://evil.com/x/.example.com/y")).toBe(false);
    expect(matchesAuthorizedUriSpec(pat, "https://evil.com/.example.com/y")).toBe(false);
  });

  it("host `**` alone matches any host but never the path portion", () => {
    const pat = "https://**/health";
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/health")).toBe(true);
    // `**` in the host cannot swallow the `/` that ends the authority.
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/v1/health")).toBe(false);
  });

  // The authority fragment is `[^/]*`, so the ONLY separator it cannot cross
  // is `/`. `?`, `#` and `@` also end an authority and are not `/` — matching
  // the RAW target string therefore let an attacker host wear an allowlisted
  // suffix. Each case below pairs the bypass with BOTH controls (a real host
  // that must still match, an attacker host that must still be refused) so a
  // change that breaks matching outright cannot masquerade as a fix.
  // `https://*.salesforce.com/**` is a shipped system-integration pattern.
  const SALESFORCE = "https://*.salesforce.com/**";

  it("`?` cannot smuggle an allowlisted suffix past the authority boundary", () => {
    // Real host is `attacker.example`; everything after `?` is the query.
    expect(
      matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example?.salesforce.com/steal"),
    ).toBe(false);
    expect(
      matchesAuthorizedUriSpec("https://*.zendesk.com/**", "https://evil.test?.zendesk.com/x"),
    ).toBe(false);
    // Positive control — a genuine subdomain still matches.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com/ok")).toBe(true);
    // Negative control — a bare attacker host was always refused.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example/steal")).toBe(false);
  });

  it("`#` cannot smuggle an allowlisted suffix past the authority boundary", () => {
    // Real host is `attacker.example`; everything after `#` is the fragment
    // and is never even sent on the wire.
    expect(
      matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example#.salesforce.com/steal"),
    ).toBe(false);
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com/ok")).toBe(true);
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example/steal")).toBe(false);
  });

  it("userinfo `@` cannot make an attacker host wear an allowlisted name", () => {
    // Checked as part of the `?`/`#` fix: `@` also detaches an authority, but
    // it was NOT a bypass against a suffix-anchored host pattern — the
    // authority `foo.salesforce.com@attacker.example` does not END in
    // `.salesforce.com`. Pinned so normalisation can never make it one.
    // Real host is `attacker.example`; `foo.salesforce.com` is userinfo.
    expect(
      matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com@attacker.example/x"),
    ).toBe(false);
    expect(
      matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com:tok@attacker.example/x"),
    ).toBe(false);
    // A fragment already stripped means the fragment can't re-add the host.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com/ok")).toBe(true);
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example/steal")).toBe(false);
  });

  it("refuses a target that is not a parseable URL", () => {
    // Fail closed: a target whose real host we cannot name never gets the
    // integration credential. A raw-string matcher happily admitted these —
    // `[^/]*` does not care that a space is illegal in an authority — but
    // `new URL()` rejects them, so there is no host to authorise.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://a b.salesforce.com/x")).toBe(false);
    expect(matchesAuthorizedUriSpec("https://**", "https://not a host/x")).toBe(false);
    expect(matchesAuthorizedUriSpec(SALESFORCE, "not a url")).toBe(false);
    expect(matchesAuthorizedUriSpec(SALESFORCE, "//foo.salesforce.com/ok")).toBe(false);
    // Positive controls — real URLs still match both patterns.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com/ok")).toBe(true);
    expect(matchesAuthorizedUriSpec("https://**", "https://foo.salesforce.com/ok")).toBe(true);
    // Negative control — a parseable attacker host is still refused.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example/steal")).toBe(false);
  });

  // Normalisation is applied to BOTH sides. It closed the `?`/`#` bypass on
  // the target; applying it only there broke every literal whose canonical
  // form differs from how its author spelled it, and left a pattern that
  // spells a default port or an uppercase host matching nothing at all.
  // Each case below pairs the widened/repaired acceptance with a rejection
  // that must survive, so the suite cannot pass by accepting everything —
  // and the bypass cases at the end make sure it cannot pass by rejecting
  // everything either.
  describe("pattern and target are normalised in the same representation", () => {
    it("a path-less literal matches its own origin (and nothing under it)", () => {
      // `URL.toString()` gives an empty path a `/`; the pattern is `$`-anchored.
      // Normalising only the target made this literal match NOTHING.
      const pat = "https://api.example.com";
      expect(matchesAuthorizedUriSpec(pat, "https://api.example.com")).toBe(true);
      // The same URL by every reading — WHATWG canonicalises both to `…com/`.
      expect(matchesAuthorizedUriSpec(pat, "https://api.example.com/")).toBe(true);
      // Rejection control: "literal → exact equality" still means exact.
      expect(matchesAuthorizedUriSpec(pat, "https://api.example.com/x")).toBe(false);
      expect(matchesAuthorizedUriSpec(pat, "https://api.example.com.evil.test/")).toBe(false);
    });

    it("a literal path containing URL-encodable characters matches itself", () => {
      // The target percent-encodes; the raw pattern did not, so every one of
      // these matched nothing. `{`/`}` is the common shape (a manifest author
      // writing a template-looking literal path).
      expect(matchesAuthorizedUriSpec("https://a.com/v1/{id}", "https://a.com/v1/{id}")).toBe(true);
      expect(matchesAuthorizedUriSpec("https://a.com/v1/a b", "https://a.com/v1/a b")).toBe(true);
      expect(matchesAuthorizedUriSpec("https://a.com/v1/a^b", "https://a.com/v1/a^b")).toBe(true);
      expect(matchesAuthorizedUriSpec("https://a.com/v1/a|b", "https://a.com/v1/a|b")).toBe(true);
      // Rejection control: encoding both sides is not the same as ignoring the
      // path — a different literal is still refused.
      expect(matchesAuthorizedUriSpec("https://a.com/v1/{id}", "https://a.com/v1/{other}")).toBe(
        false,
      );
      expect(matchesAuthorizedUriSpec("https://a.com/v1/{id}", "https://evil.test/v1/{id}")).toBe(
        false,
      );
    });

    it("widening 1 — the DEFAULT port is elided on both sides, others are not", () => {
      // `:443` IS the https authority; WHATWG drops it from both sides.
      expect(
        matchesAuthorizedUriSpec("https://*.wrike.com/api/**", "https://www.wrike.com:443/api/x"),
      ).toBe(true);
      // …and a pattern that spells it explicitly finally matches at all —
      // before, this pattern matched neither the ported nor the unported form.
      expect(
        matchesAuthorizedUriSpec("https://*.wrike.com:443/api/**", "https://www.wrike.com/api/x"),
      ).toBe(true);
      expect(
        matchesAuthorizedUriSpec(
          "https://*.wrike.com:443/api/**",
          "https://www.wrike.com:443/api/x",
        ),
      ).toBe(true);
      // Rejection control: a NON-default port is part of the host component
      // and still has to match.
      expect(
        matchesAuthorizedUriSpec("https://*.wrike.com/api/**", "https://www.wrike.com:8443/api/x"),
      ).toBe(false);
      expect(
        matchesAuthorizedUriSpec("https://*.wrike.com:8443/api/**", "https://www.wrike.com/api/x"),
      ).toBe(false);
    });

    it("widening 2 — scheme and host case-fold on both sides, the path does not", () => {
      // Target-side folding already happened; the pattern side did not, so an
      // uppercase-host pattern matched nothing.
      expect(
        matchesAuthorizedUriSpec("https://*.SALESFORCE.com/**", "https://x.salesforce.com/a"),
      ).toBe(true);
      expect(
        matchesAuthorizedUriSpec("HTTPS://*.salesforce.com/**", "https://x.salesforce.com/a"),
      ).toBe(true);
      expect(
        matchesAuthorizedUriSpec("https://*.salesforce.com/**", "HTTPS://X.SALESFORCE.COM/a"),
      ).toBe(true);
      // Rejection control: RFC 3986 case-folds scheme and host ONLY — the path
      // stays case-sensitive on both sides.
      expect(matchesAuthorizedUriSpec("https://a.com/Secret", "https://a.com/secret")).toBe(false);
      expect(matchesAuthorizedUriSpec("https://a.com/secret", "https://a.com/SECRET")).toBe(false);
    });

    it("widening 3 — dot-segments resolve first, so traversal cannot leave the prefix", () => {
      // This one TIGHTENS: the request that goes on the wire is for `/evil`.
      expect(
        matchesAuthorizedUriSpec("https://slack.com/api/**", "https://slack.com/api/../../evil"),
      ).toBe(false);
      expect(
        matchesAuthorizedUriSpec("https://slack.com/api/**", "https://slack.com/api/../evil"),
      ).toBe(false);
      // Acceptance control: traversal that stays INSIDE the prefix still
      // matches, so this is not "reject anything containing `..`".
      expect(
        matchesAuthorizedUriSpec("https://slack.com/api/**", "https://slack.com/api/v1/../chat"),
      ).toBe(true);
      expect(
        matchesAuthorizedUriSpec("https://slack.com/api/**", "https://slack.com/api/chat"),
      ).toBe(true);
    });

    it("normalising the pattern does not reopen the authority-smuggling bypasses", () => {
      // The two cases the target-side normalisation was written for. Re-asserted
      // here because the pattern side is what changed around them.
      expect(
        matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example?.salesforce.com/steal"),
      ).toBe(false);
      expect(
        matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example#.salesforce.com/steal"),
      ).toBe(false);
      expect(
        matchesAuthorizedUriSpec("https://**.example.com/**", "https://evil.com/x/.example.com/y"),
      ).toBe(false);
      // Acceptance controls — the same patterns still admit real hosts.
      expect(matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com/ok")).toBe(true);
      expect(
        matchesAuthorizedUriSpec("https://**.example.com/**", "https://a.b.example.com/x/y"),
      ).toBe(true);
    });

    it("a globbed scheme stays a scheme: it cannot match a host named inside a query", () => {
      const pat = "**://api.example.com/**";
      expect(matchesAuthorizedUriSpec(pat, "https://evil.com/x?y=://api.example.com/")).toBe(false);
      expect(
        matchesAuthorizedUriSpec("*://api.example.com/**", "https://evil.com/?://api.example.com/"),
      ).toBe(false);
      expect(matchesAuthorizedUriSpec(pat, "https://api.example.com/v1?q=1")).toBe(true);
      expect(matchesAuthorizedUriSpec("*://**", "http://any.example/a")).toBe(true);
    });

    it("normalisation never moves a wildcard into an empty authority", () => {
      expect(matchesAuthorizedUriSpec("https:///**", "https://evil.com/")).toBe(false);
      expect(matchesAuthorizedUriSpec("https:///*", "https://evil.com/")).toBe(false);
      // An empty authority is malformed, even when WHATWG would read a host after it.
      expect(
        matchesAuthorizedUriSpec("https:///api.example.com/x", "https://api.example.com/x"),
      ).toBe(false);
    });

    it("a pattern that already contains the wildcard placeholder still compiles", () => {
      // The masking placeholder is chosen to be absent from the pattern, so a
      // pattern spelling it literally cannot have a wildcard forged into it.
      const pat = "https://zzurisinglezz.salesforce.com/*";
      expect(matchesAuthorizedUriSpec(pat, "https://zzurisinglezz.salesforce.com/x")).toBe(true);
      expect(matchesAuthorizedUriSpec(pat, "https://evil.example/x")).toBe(false);
      // The literal placeholder is a host, not a wildcard: another host is refused.
      expect(matchesAuthorizedUriSpec(pat, "https://other.salesforce.com/x")).toBe(false);
    });

    it("the bare `scheme://**` catch-all survives normalisation", () => {
      // Decided before normalisation: `new URL()` would add the `/` that turns
      // "any host, any path" into "any host, root only".
      expect(matchesAuthorizedUriSpec("https://**", "https://anything.example/a/b")).toBe(true);
      expect(matchesAuthorizedUriSpec("https://**", "https://anything.example")).toBe(true);
      expect(matchesAuthorizedUriSpec("HTTPS://**", "https://anything.example/a/b")).toBe(true);
      // Rejection control: still scheme-anchored, and still fails closed on a
      // target that is not a URL.
      expect(matchesAuthorizedUriSpec("https://**", "http://anything.example/a/b")).toBe(false);
      expect(matchesAuthorizedUriSpec("https://**", "not a url")).toBe(false);
    });
  });

  it("normalisation leaves path/query wildcards working", () => {
    const pat = "https://*.salesforce.com/services/data/**";
    expect(
      matchesAuthorizedUriSpec(
        pat,
        "https://foo.salesforce.com/services/data/v59.0/query?q=SELECT+Id",
      ),
    ).toBe(true);
    // Single-segment `*` still stops at a slash after normalisation.
    expect(matchesAuthorizedUriSpec("https://api.acme.com/*", "https://api.acme.com/users")).toBe(
      true,
    );
    expect(
      matchesAuthorizedUriSpec("https://api.acme.com/*", "https://api.acme.com/users/42"),
    ).toBe(false);
    // …and the path is still not a place to hide a host.
    expect(matchesAuthorizedUriSpec(pat, "https://attacker.example/services/data/v59.0")).toBe(
      false,
    );
  });
  it("a malformed authority matches nothing, however WHATWG would rewrite it", () => {
    for (const pattern of [
      "https://%2A%2A\\**",
      "https://@x:y@**/**",
      "https://*.example.com@**/**",
      "https://%2A.example.com/**",
      "https://*.example.com\\.evil.test/**",
      "https://ａpi.example.com/**",
    ]) {
      expect([pattern, matchesAuthorizedUriSpec(pattern, "https://attacker.test/steal")]).toEqual([
        pattern,
        false,
      ]);
    }
  });

  it("agrees with isHostUnboundedUriPattern: a host-bound entry never reaches another host", () => {
    const targets = [
      "https://attacker.test/steal",
      "https://a.attacker.test/steal",
      "https://[::ffff:5db8:d822]/steal",
      "https://45.33.0.1/steal",
      "https://0x2d210001/steal",
      "https://8.168.1.1/steal",
    ];
    for (const pattern of [
      "https://*.example.com/**",
      "https://api.example.com:*/**",
      "https://*.example.com./**",
      "HTTPS://*.EXAMPLE.com:443/**",
      "https://%2A%2A\\**",
      "https://@x:y@**/**",
      "https://[::**/**",
      "https://*:x.example.com/**",
      "https:///**",
      "**://api.example.com/**",
      "https://**/**",
      "https://*.0.1/**",
      "https://*.168.1.1/**",
      "https://[::ffff:*.2.3.4]/**",
    ]) {
      const reaches = targets.some((t) => matchesAuthorizedUriSpec(pattern, t));
      expect([pattern, reaches && !isHostUnboundedUriPattern(pattern)]).toEqual([pattern, false]);
    }
    // Control: the table does reach other hosts, through entries the rule calls unbounded.
    expect(matchesAuthorizedUriSpec("https://**/**", targets[0]!)).toBe(true);
    expect(matchesAuthorizedUriSpec("https://[::**/**", targets[2]!)).toBe(true);
    expect(matchesAuthorizedUriSpec("https://*.0.1/**", "https://0x2d210001/steal")).toBe(true);
    expect(matchesAuthorizedUriSpec("https://*.168.1.1/**", "https://8.168.1.1/steal")).toBe(true);
  });
});

describe("hostLiterallyAllowlisted", () => {
  it("pins an exact literal host", () => {
    expect(
      hostLiterallyAllowlisted("https://api.example.com/x", ["https://api.example.com/**"]),
    ).toBe(true);
  });

  it("never pins a glob host", () => {
    expect(hostLiterallyAllowlisted("https://anything.example/x", ["https://**"])).toBe(false);
    expect(hostLiterallyAllowlisted("https://a.example.com/x", ["https://*.example.com/**"])).toBe(
      false,
    );
  });

  it("tolerates a globbed scheme on a literal host", () => {
    expect(hostLiterallyAllowlisted("https://intranet.corp/x", ["**://intranet.corp/**"])).toBe(
      true,
    );
  });

  it("tolerates a globbed port on a literal host", () => {
    expect(
      hostLiterallyAllowlisted("https://intranet.corp/x", ["https://intranet.corp:*/**"]),
    ).toBe(true);
  });

  it("strips a literal port from the spec authority", () => {
    expect(
      hostLiterallyAllowlisted("https://api.example.com/x", ["https://api.example.com:8443/**"]),
    ).toBe(true);
  });

  it("never pins through a malformed entry, which the matcher refuses too", () => {
    for (const spec of ["https://user@api.example.com/**", "https://api%2Eexample.com/**"]) {
      expect(hostLiterallyAllowlisted("https://api.example.com/x", [spec])).toBe(false);
    }
  });

  it("compares hosts case-insensitively", () => {
    expect(
      hostLiterallyAllowlisted("https://API.Example.com/x", ["https://api.example.com/**"]),
    ).toBe(true);
  });

  it("never pins a templated host, even one spelled literally in the target", () => {
    expect(
      hostLiterallyAllowlisted("https://{$credential.host}/x", ["https://{$credential.host}/**"]),
    ).toBe(false);
  });

  it("returns false on an unparseable URL", () => {
    expect(hostLiterallyAllowlisted("::::", ["https://api.example.com/**"])).toBe(false);
  });
});

/**
 * Tests for `compileEgressPolicy`: the runner egress allowlist compiled from
 * one connection's rendered `authorized_uris`, projected onto (host, port)
 * for TCP-level checks and applied as-is to full URLs.
 */
const policy = (...authorizedUris: string[]) =>
  compileEgressPolicy({ authorizedUris, allowAllUris: false });

describe("compileEgressPolicy — allowsAuthority", () => {
  it("applies the scheme's default port to a port-less pattern", () => {
    const p = policy("https://api.github.com/**");
    expect(p.allowsAuthority("api.github.com", 443)).toBe(true);
    expect(p.allowsAuthority("api.github.com", 80)).toBe(false);
    expect(p.allowsAuthority("evil.com", 443)).toBe(false);
  });

  it("treats `https://h:443` and `https://h` identically", () => {
    for (const pattern of ["https://h.example.com:443/**", "https://h.example.com/**"]) {
      const p = policy(pattern);
      expect(p.allowsAuthority("h.example.com", 443)).toBe(true);
      expect(p.allowsAuthority("h.example.com", 8443)).toBe(false);
    }
  });

  it("uses the default table for http/ws/wss/sftp", () => {
    expect(policy("http://h.com/**").allowsAuthority("h.com", 80)).toBe(true);
    expect(policy("ws://h.com").allowsAuthority("h.com", 80)).toBe(true);
    expect(policy("wss://h.com").allowsAuthority("h.com", 443)).toBe(true);
    expect(policy("sftp://h.com").allowsAuthority("h.com", 22)).toBe(true);
    expect(policy("sftp://h.com").allowsAuthority("h.com", 2222)).toBe(false);
  });

  it("grants no host through an empty authority or a globbed scheme", () => {
    for (const pattern of ["https:///**", "**://**", "*://api.example.com/**"]) {
      const p = policy(pattern);
      expect(p.allowsAuthority("evil.com", 443)).toBe(false);
      expect(p.allowsAuthority("api.example.com", 443)).toBe(false);
    }
    expect(policy("https:///**").allowsUrl("https://evil.com/x")).toBe(false);
  });

  it("requires an explicit port to equal the target port", () => {
    const p = policy("ssh://h.example.com:2222");
    expect(p.allowsAuthority("h.example.com", 2222)).toBe(true);
    expect(p.allowsAuthority("h.example.com", 22)).toBe(false);
  });

  it("keeps a host wildcard in a port-less pattern on the scheme's default port", () => {
    const any = policy("https://*/**");
    expect(any.allowsAuthority("evil.com", 443)).toBe(true);
    expect(any.allowsAuthority("evil.com", 25)).toBe(false);
    const api = policy("https://api.*/**");
    expect(api.allowsAuthority("api.x.com", 443)).toBe(true);
    expect(api.allowsAuthority("api.x.com", 8443)).toBe(false);
  });

  it("matches an explicit non-default port only on that port", () => {
    const p = policy("https://h.example.com:8443/**");
    expect(p.allowsAuthority("h.example.com", 8443)).toBe(true);
    expect(p.allowsAuthority("h.example.com", 443)).toBe(false);
    const wild = policy("https://*.x.com:8443/**");
    expect(wild.allowsAuthority("a.x.com", 8443)).toBe(true);
    expect(wild.allowsAuthority("a.x.com", 443)).toBe(false);
  });

  it("lets an explicit `:*` port grant any port on that host", () => {
    const p = policy("https://h.example.com:*/**");
    expect(p.allowsAuthority("h.example.com", 25)).toBe(true);
    expect(p.allowsAuthority("evil.com", 25)).toBe(false);
  });

  it("matches a subdomain wildcard across dots", () => {
    const p = policy("https://*.x.com/**");
    expect(p.allowsAuthority("a.b.x.com", 443)).toBe(true);
    expect(p.allowsAuthority("a.x.com", 8443)).toBe(false);
    expect(p.allowsAuthority("x.com.evil.com", 443)).toBe(false);
  });

  it("compares hosts case-insensitively, including non-special schemes", () => {
    const p = policy("ssh://Host.Example.com:22");
    expect(p.allowsAuthority("host.example.com", 22)).toBe(true);
    expect(p.allowsAuthority("HOST.EXAMPLE.COM", 22)).toBe(true);
  });

  it("lets the bare `scheme://**` catch-all through any host and port", () => {
    const p = policy("ssh://**");
    expect(p.allowsAuthority("anything.example", 22)).toBe(true);
    expect(p.allowsAuthority("anything.example", 8443)).toBe(true);
  });

  it("grants nothing for scheme-less, unrendered or unknown-scheme-without-port patterns", () => {
    expect(policy("api.x.com/**").allowsAuthority("api.x.com", 443)).toBe(false);
    const templated = policy("ssh://{$credential.host}:22");
    expect(templated.allowsAuthority("{$credential.host}", 22)).toBe(false);
    expect(templated.allowsAuthority("h.com", 22)).toBe(false);
    expect(policy("foo://h.com").allowsAuthority("h.com", 1234)).toBe(false);
    expect(policy("foo://h.com:1234").allowsAuthority("h.com", 1234)).toBe(true);
  });

  it("refuses IPv6, smuggling characters and invalid ports", () => {
    const p = policy("https://*.x.com/**", "ssh://**");
    expect(p.allowsAuthority("::1", 22)).toBe(false);
    expect(p.allowsAuthority("[::1]", 22)).toBe(false);
    expect(p.allowsAuthority("evil.com#.x.com", 443)).toBe(false);
    expect(p.allowsAuthority("evil.com@a.x.com", 443)).toBe(false);
    for (const port of [0, -1, 65536, Number.NaN, 22.5]) {
      expect(p.allowsAuthority("a.x.com", port)).toBe(false);
    }
  });

  it("grants nothing through a malformed entry, at TCP or URL level", () => {
    for (const pattern of ["https://@x:y@**/**", "https://%2A%2A\\**", "https://a.com@evil.test"]) {
      const p = policy(pattern);
      expect(p.allowsAuthority("evil.test", 443)).toBe(false);
      expect(p.allowsUrl("https://evil.test/steal")).toBe(false);
    }
  });

  it("denies everything for an empty list", () => {
    expect(policy().allowsAuthority("api.github.com", 443)).toBe(false);
  });
});

describe("compileEgressPolicy — allowsUrl", () => {
  it("is path-aware, like matchesAuthorizedUriSpec", () => {
    const p = policy("https://api.x.com/v1/**");
    expect(p.allowsUrl("https://api.x.com/v1/a")).toBe(true);
    expect(p.allowsUrl("https://api.x.com/v2/a")).toBe(false);
    expect(p.allowsUrl("https://evil.com?.api.x.com/v1/a")).toBe(false);
    expect(p.allowsUrl("not a url")).toBe(false);
  });

  it("matches when any pattern matches", () => {
    const p = policy("https://a.com/x", "https://b.com/**");
    expect(p.allowsUrl("https://a.com/x")).toBe(true);
    expect(p.allowsUrl("https://b.com/y/z")).toBe(true);
    expect(p.allowsUrl("https://a.com/y")).toBe(false);
  });

  it("denies everything for an empty list", () => {
    expect(policy().allowsUrl("https://api.github.com/")).toBe(false);
  });
});

describe("compileEgressPolicy — allowAllUris", () => {
  it("allows every authority and URL", () => {
    const p = compileEgressPolicy({ authorizedUris: [], allowAllUris: true });
    expect(p.allowsAuthority("anything.example", 8443)).toBe(true);
    expect(p.allowsUrl("https://anything.example/x")).toBe(true);
  });
});
