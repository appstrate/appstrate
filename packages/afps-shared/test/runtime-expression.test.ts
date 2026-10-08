// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  loginBlockIssues,
  parseResponseExpression,
  simpleCriterionOperands,
} from "../src/runtime-expression.ts";

describe("parseResponseExpression", () => {
  it("parses the four response expressions", () => {
    expect(parseResponseExpression("$statusCode")).toEqual({ kind: "status" });
    expect(parseResponseExpression("$response.body")).toEqual({ kind: "body" });
    expect(parseResponseExpression("$response.body#/a/0")).toEqual({
      kind: "body",
      pointer: "/a/0",
    });
    expect(parseResponseExpression("$response.header.X-Token")).toEqual({
      kind: "header",
      name: "X-Token",
    });
  });

  for (const bad of [
    "$outputs.token",
    "$response.body#a",
    "$response.header.",
    "$response.header.a b",
    "{$response.body}",
    "$request.body",
  ]) {
    it(`refuses ${bad}`, () => {
      expect(parseResponseExpression(bad)).toBeNull();
    });
  }
});

describe("simpleCriterionOperands", () => {
  it("splits on the first == and trims", () => {
    expect(simpleCriterionOperands("$statusCode == 200")).toEqual(["$statusCode", "200"]);
    expect(simpleCriterionOperands("a == b == c")).toEqual(["a", "b == c"]);
    expect(simpleCriterionOperands("$statusCode")).toBeNull();
  });
});

describe("loginBlockIssues", () => {
  const request = { url: "https://idp.example.com/login", body: "p={{password}}" };
  const paths = (login: Parameters<typeof loginBlockIssues>[0]) =>
    loginBlockIssues(login).map((i) => i.path.join("."));

  it("accepts every form the login engine evaluates", () => {
    expect(
      loginBlockIssues({
        request,
        outputs: {
          token: "$response.body#/token",
          csrf: { from: "regex", source: "$response.header.Set-Cookie", pattern: "c=(\\w+)" },
          sub: { from: "jwt", token: "{$credential.token}", path: "/sub" },
          sel: { context: "$response.body", selector: "$.a", type: "jsonpath" },
          sid: { from: "cookie", name: "sid" },
        },
        success_criteria: [
          { condition: "$statusCode == 200" },
          { condition: "$.ok", type: "jsonpath" },
          { condition: "ok", type: "regex", context: "$response.header.X" },
        ],
      }),
    ).toEqual([]);
  });

  it("runs a regex output only on the whole body or one header", () => {
    const regex = (source: string) => ({ outputs: { t: { from: "regex", source } } });
    expect(paths(regex("$response.body"))).toEqual([]);
    expect(paths(regex("$response.header.Set-Cookie"))).toEqual([]);
    expect(paths(regex("$response.body#/token"))).toEqual(["outputs.t.source"]);
    expect(paths(regex("$statusCode"))).toEqual(["outputs.t.source"]);
  });

  it("locates each expression the engine cannot evaluate", () => {
    expect(
      paths({
        request: { url: "https://{$credential.host}/login", headers: { A: "{$inputs.a}" } },
        outputs: {
          alias: "$outputs.token",
          sel: { context: "$response.header.X", selector: "$.a", type: "jsonpath" },
          bare: { from: "jwt", token: "token", path: "/sub" },
          chained: { from: "jwt", token: "{$credential.bare}", path: "/sub" },
          braced: { from: "regex", source: "{$response.body}", pattern: "(.+)" },
        },
        success_criteria: [
          { condition: "$status == 200" },
          { condition: "$.ok", type: "jsonpath", context: "$response.header.X" },
          { condition: "ok", type: "regex", context: "$response.body#/a" },
        ],
      }),
    ).toEqual([
      "request.url",
      "request.headers.A",
      "outputs.alias",
      "outputs.sel.context",
      "outputs.bare.token",
      "outputs.chained.token",
      "outputs.braced.source",
      "success_criteria.0",
      "success_criteria.1",
      "success_criteria.2",
    ]);
  });
});

describe("loginBlockIssues — connection variables (§7.7, §7.12)", () => {
  const paths = (url: string, extra: { body?: string; headers?: Record<string, string> } = {}) =>
    loginBlockIssues({ request: { url, ...extra } }).map((i) => i.path.join("."));

  it("accepts a URL-template url", () => {
    expect(paths("{$variable.base_url}/api/login")).toEqual([]);
    expect(paths("https://{$variable.tenant}.example.com/login")).toEqual([]);
  });

  it("refuses a variable url that is not a URL template, or carries {{name}}", () => {
    expect(paths("{$variable.base_url}/login?u={{user}}")).toEqual(["request.url"]);
    expect(paths("https://example.com/{$variable.tenant}/login")).toEqual(["request.url"]);
    expect(paths("{$variable.base_url}/{$credential.path}")).toEqual(["request.url"]);
  });

  it("still refuses {$…} in the body and headers", () => {
    expect(
      paths("{$variable.base_url}/login", {
        body: "{$variable.base_url}",
        headers: { Host: "{$variable.tenant}" },
      }),
    ).toEqual(["request.body", "request.headers.Host"]);
  });
});
