// SPDX-License-Identifier: Apache-2.0

/**
 * `toCredentialStringMap` — the one projection every credential reader applies
 * (sidecar delivery, token refresh, connect-run login inputs, run-start
 * re-bootstrap). Credentials may hold any JSON type (AFPS §7.5); none may be
 * lost silently on the way to a `{$credential.<field>}` template (#1897).
 */

import { describe, it, expect } from "bun:test";
import { toCredentialStringMap } from "../src/integration-credentials.ts";

describe("toCredentialStringMap", () => {
  it("passes strings through untouched, the empty string and JSON-looking text included", () => {
    expect(
      toCredentialStringMap({ api_key: "k", blank: "", quoted: '"x"', braces: "{}", num: "5432" }),
    ).toEqual({ api_key: "k", blank: "", quoted: '"x"', braces: "{}", num: "5432" });
  });

  it("JSON-encodes numbers, zero and negatives included", () => {
    expect(toCredentialStringMap({ port: 5432, zero: 0, neg: -1, frac: 1.5 })).toEqual({
      port: "5432",
      zero: "0",
      neg: "-1",
      frac: "1.5",
    });
  });

  it("JSON-encodes both booleans — `false` is a value, not an absence", () => {
    expect(toCredentialStringMap({ tls: true, verify: false })).toEqual({
      tls: "true",
      verify: "false",
    });
  });

  it("JSON-encodes arrays and objects, never `[object Object]` nor a comma join", () => {
    const out = toCredentialStringMap({
      scopes: ["a", "b,c"],
      empty: [],
      cfg: { host: "db", port: 5432, nested: { on: true } },
      none: {},
    });
    expect(out).toEqual({
      scopes: '["a","b,c"]',
      empty: "[]",
      cfg: '{"host":"db","port":5432,"nested":{"on":true}}',
      none: "{}",
    });
    // Lossless: the text parses back to the stored value.
    expect(JSON.parse(out.scopes!)).toEqual(["a", "b,c"]);
    expect(JSON.parse(out.cfg!)).toEqual({ host: "db", port: 5432, nested: { on: true } });
  });

  it("leaves out null and undefined — an absent credential, never the text `null`", () => {
    const out = toCredentialStringMap({ api_key: "k", gone: null, unset: undefined });
    expect(out).toEqual({ api_key: "k" });
    expect(Object.hasOwn(out, "gone")).toBe(false);
    expect(Object.hasOwn(out, "unset")).toBe(false);
  });

  it("returns an empty map for an empty bag and never mutates its input", () => {
    expect(toCredentialStringMap({})).toEqual({});
    const raw = { port: 5432, tags: ["a"] };
    toCredentialStringMap(raw);
    expect(raw).toEqual({ port: 5432, tags: ["a"] });
  });

  it("is stable across a JSON round trip — the shape credentials are stored in", () => {
    const stored = { api_key: "k", port: 5432, tls: false, tags: ["x"], gone: null };
    const decoded = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    expect(toCredentialStringMap(decoded)).toEqual(toCredentialStringMap(stored));
  });
});
