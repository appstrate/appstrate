// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  isResponseTextExpression,
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

describe("isResponseTextExpression", () => {
  it("is the whole body or one header", () => {
    expect(isResponseTextExpression("$response.body")).toBe(true);
    expect(isResponseTextExpression("$response.header.Set-Cookie")).toBe(true);
    expect(isResponseTextExpression("$response.body#/token")).toBe(false);
    expect(isResponseTextExpression("$statusCode")).toBe(false);
  });
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
