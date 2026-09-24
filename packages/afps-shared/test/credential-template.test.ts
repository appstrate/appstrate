// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { credentialTemplateRefs, renderAuthorizedUris } from "../src/credential-template.ts";

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
