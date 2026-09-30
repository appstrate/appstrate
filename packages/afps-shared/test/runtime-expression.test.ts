// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { isResponseTextExpression, parseResponseExpression } from "../src/runtime-expression.ts";

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
