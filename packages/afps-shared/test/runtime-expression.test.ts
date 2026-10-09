// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  isSelectorOutput,
  loginBlockIssues,
  parseResponseExpression,
  simpleCriterionOperands,
  type SimpleOperand,
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
  const status: SimpleOperand = { kind: "expression", expression: { kind: "status" } };
  const body = (pointer: string): SimpleOperand => ({
    kind: "expression",
    expression: { kind: "body", pointer },
  });
  const literal = (value: string | number | boolean | null): SimpleOperand => ({
    kind: "literal",
    value,
  });
  const accepted: [string, [SimpleOperand, SimpleOperand]][] = [
    ["$statusCode == 200", [status, literal(200)]],
    ["200 == $statusCode", [literal(200), status]],
    ["$response.body#/n == -1.5", [body("/n"), literal(-1.5)]],
    ["$response.body#/ok == true", [body("/ok"), literal(true)]],
    ["$response.body#/a == null", [body("/a"), literal(null)]],
    ["$response.body#/s == 'x<y'", [body("/s"), literal("x<y")]],
    ["$response.body#/s == 'O''Brien'", [body("/s"), literal("O'Brien")]],
    [`$response.body#/s == "a == b && !c"`, [body("/s"), literal("a == b && !c")]],
    [
      `$response.header.X-Ok == "yes"`,
      [{ kind: "expression", expression: { kind: "header", name: "X-Ok" } }, literal("yes")],
    ],
    ["$response.body#/a == $response.body#/b", [body("/a"), body("/b")]],
    ["$statusCode == 2e2", [status, literal(200)]],
    ["$response.body#/x == -1.5E-3", [body("/x"), literal(-0.0015)]],
  ];
  for (const [condition, operands] of accepted) {
    it(`parses ${condition}`, () => {
      expect(simpleCriterionOperands(condition)).toEqual(operands);
    });
  }

  for (const other of [
    "$statusCode",
    "$statusCode ==",
    "a == b == c",
    "$statusCode === 200",
    "$statusCode != 401",
    "$statusCode >= 200",
    "$statusCode == 200 && $response.body#/ok == true",
    "$statusCode == 200 || $statusCode == 201",
    "!$response.body#/ok == true",
    "($statusCode == 200)",
    `$response.body#/s == "\\""`,
    "$response.body#/a=b == 1",
    "$status == 200",
    "$statusCode == {$response.body}",
    "$response.body#/s == OK",
    "$response.body#/ok == True",
    "$response.body#/a == []",
    "$response.body#/s == hello world",
    "'a' == 'a'",
    "$statusCode == +200",
    "$statusCode == .5",
    "$statusCode == 5.",
    "$statusCode == 0x10",
    "$statusCode == 0200",
    `$response.body#/a"<"b == 1`,
    "$response.body#/a~2 == 1",
  ]) {
    it(`refuses ${other}`, () => {
      expect(simpleCriterionOperands(other)).toBeNull();
    });
  }
});

describe("isSelectorOutput", () => {
  it("classifies by `from` alone", () => {
    expect(isSelectorOutput({ context: "$response.body", selector: "$.a", type: "jsonpath" })).toBe(
      true,
    );
    expect(isSelectorOutput({ context: "$response.body" })).toBe(true);
    expect(
      isSelectorOutput({ from: "cookie", name: "sid", selector: "/a", type: "jsonpointer" }),
    ).toBe(false);
    expect(isSelectorOutput("$response.body")).toBe(false);
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
          whole: { from: "regex", source: "$response.body", pattern: "t=\\w+", group: 0 },
          sel: { context: "$response.body", selector: "$.a", type: "jsonpath" },
          ptr: { context: "$response.body", selector: "/a/0", type: "jsonpointer" },
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
    const regex = (source: string) => ({
      outputs: { t: { from: "regex", source, pattern: "t=(\\w+)" } },
    });
    expect(paths(regex("$response.body"))).toEqual([]);
    expect(paths(regex("$response.header.Set-Cookie"))).toEqual([]);
    expect(paths(regex("$response.body#/token"))).toEqual(["outputs.t.source"]);
    expect(paths(regex("$statusCode"))).toEqual(["outputs.t.source"]);
  });

  it("names an invalid pointer, and refuses an output named __proto__", () => {
    const [pointer] = loginBlockIssues({
      success_criteria: [{ condition: "$response.body#/a~x == 1" }],
    });
    expect(pointer!.message).toContain("'$response.body#/a~x' is not an RFC 6901 pointer");
    const outputs = JSON.parse('{"__proto__": "$statusCode"}') as Record<string, unknown>;
    expect(paths({ outputs })).toEqual(["outputs.__proto__"]);
  });

  it("evaluates a variable only in a login url that is a URL template (§7.12)", () => {
    for (const url of [
      "{$variable.base_url}/login",
      "https://{$variable.tenant}.example.com/login",
    ]) {
      expect(paths({ request: { url } })).toEqual([]);
    }
    expect(
      paths({
        request: {
          url: "https://example.com/{$variable.tenant}/login",
          body: "base={$variable.base_url}",
          headers: { Host: "{$variable.tenant}" },
        },
      }),
    ).toEqual(["request.url", "request.body", "request.headers.Host"]);
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
          xml: { context: "$response.body", selector: "//token/text()", type: "xpath" },
          untyped: { context: "$response.body", selector: "$.a" },
          ptr: { context: "$response.body", selector: "a/b", type: "jsonpointer" },
          claim: { from: "jwt", token: "{$credential.raw}", path: "sub" },
          raw: { from: "regex", source: "$response.body", pattern: "(?<x" },
          nogroup: { from: "regex", source: "$response.body", pattern: "t=\\w+" },
          deep: { context: "$response.body", selector: "$..token", type: "jsonpath" },
          mixed: {
            from: "regex",
            source: "$response.body",
            pattern: "t=(\\w+)",
            context: "$response.body",
            selector: "//t",
            type: "xpath",
          },
        },
        success_criteria: [
          { condition: "$status == 200" },
          { condition: "$.ok", type: "jsonpath", context: "$response.header.X" },
          { condition: "ok", type: "regex", context: "$response.body#/a" },
          { condition: "$statusCode != 401" },
          { condition: "$statusCode >= 200" },
          { condition: "$statusCode == 200 && $response.body#/ok == true" },
          { condition: "$statusCode == 200 || $statusCode == 201" },
          { condition: "//status[text()='ok']", type: "xpath" },
          { condition: '(?i)"ok"', type: "regex" },
          { condition: "$[?(@.ok)]", type: "jsonpath" },
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
      "outputs.xml.type",
      "outputs.untyped.type",
      "outputs.ptr.selector",
      "outputs.claim.path",
      "outputs.raw.pattern",
      "outputs.nogroup.pattern",
      "outputs.deep.selector",
      "outputs.mixed",
      "success_criteria.0",
      "success_criteria.1",
      "success_criteria.2",
      "success_criteria.3",
      "success_criteria.4",
      "success_criteria.5",
      "success_criteria.6",
      "success_criteria.7.type",
      "success_criteria.8",
      "success_criteria.9",
    ]);
  });
});
