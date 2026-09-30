// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  credentialTemplateRefs,
  parseUrlFormPattern,
  renderAuthorizedUris,
  unrenderableAuthorizedUriFields,
} from "../src/credential-template.ts";

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

  it("never echoes the value", () => {
    const [entry] = unrenderableAuthorizedUriFields(["{$credential.u}/**"], { u: "sk-secret" });
    expect(JSON.stringify(entry)).not.toContain("sk-secret");
  });

  it("ignores untemplated patterns", () => {
    expect(unrenderableAuthorizedUriFields(["https://api.example.com/**"], {})).toEqual([]);
  });
});
