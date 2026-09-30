// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  credentialTemplateRefs,
  isHostUnboundedUriPattern,
  parseAuthorizedUriPattern,
  parseCredentialRef,
  parseUrlFormPattern,
  renderAuthorizedUris,
  renderCredentialTemplate,
  templateExpressions,
  unrenderableAuthorizedUriFields,
  unsupportedTemplateExpressions,
} from "../src/credential-template.ts";

describe("renderCredentialTemplate", () => {
  it("renders {$credential.<field>} refs, never a value's own braces", () => {
    expect(renderCredentialTemplate("x {$credential.a}", { a: "{{b}}" })).toBe("x {{b}}");
  });

  it("renders a missing or inherited field empty", () => {
    expect(renderCredentialTemplate("[{$credential.x}{$credential.constructor}]", {})).toBe("[]");
  });

  for (const expr of [
    "{$outputs.token}",
    "{$credential.a-b}",
    "{$inputs.password}",
    "{$}",
    "{{access_token}}",
    "{{ token }}",
  ]) {
    it(`throws on ${expr} rather than rendering it literally`, () => {
      expect(() => renderCredentialTemplate(`Bearer ${expr}`, { token: "t" })).toThrow(
        `unsupported template expression '${expr}'`,
      );
    });
  }
});

describe("template expressions", () => {
  it("parseCredentialRef accepts exactly one whole reference", () => {
    expect(parseCredentialRef("{$credential.access_token}")).toBe("access_token");
    expect(parseCredentialRef("x{$credential.a}")).toBeNull();
    expect(parseCredentialRef("{$outputs.a}")).toBeNull();
    expect(parseCredentialRef("access_token")).toBeNull();
  });

  it("lists every {$…} expression, and those that are not credential refs", () => {
    const t = "{$credential.a}:{$outputs.b}/{$credential.a}{{c}}";
    expect(templateExpressions(t)).toEqual(["{$credential.a}", "{$outputs.b}"]);
    expect(unsupportedTemplateExpressions(t)).toEqual(["{$outputs.b}"]);
  });
});

describe("credentialTemplateRefs", () => {
  it("returns referenced fields in order, deduplicated", () => {
    expect(
      credentialTemplateRefs("{$credential.b}:{$credential.a}/{$credential.b}?{$credential.c}"),
    ).toEqual(["b", "a", "c"]);
  });

  it("returns [] for an untemplated string", () => {
    expect(credentialTemplateRefs("https://api.example.com/**")).toEqual([]);
  });
});

describe("renderAuthorizedUris", () => {
  const ssh = "ssh://{$credential.host}:{$credential.port}";

  it("passes untemplated patterns unchanged, braces a delivery template refuses included", () => {
    const patterns = ["https://api.example.com/**", "ssh://**", "https://a.com/v1/{{id}}"];
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
