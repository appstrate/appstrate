// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  substituteRequest,
  UnencodableInputError,
  urlAuthorityInputs,
} from "../../src/resolvers/request-template.ts";

const url = (template: string, inputs: Record<string, unknown>) =>
  substituteRequest({ url: template, headers: {}, body: undefined }, inputs).url;

describe("substituteRequest — URL", () => {
  it("a placeholder after a literal host is encoded whole: it cannot open a path or a query", () => {
    expect(url("https://h.example{{p}}", { p: "/login?admin=1#" })).toBe(
      "https://h.example%2Flogin%3Fadmin%3D1%23",
    );
    expect(urlAuthorityInputs("https://h.example{{p}}")).toEqual(["p"]);
  });

  it("a leading base URL is spliced as is; a placeholder right after it is encoded", () => {
    expect(url("{{base}}{{path}}", { base: "https://h.example", path: "/login?admin=1&x=" })).toBe(
      "https://h.example%2Flogin%3Fadmin%3D1%26x%3D",
    );
    expect(urlAuthorityInputs("{{base}}{{path}}")).toEqual(["base", "path"]);
    expect(url("{{base_url}}/x?y={{v}}", { base_url: "https://h.example/app", v: "a&b=c" })).toBe(
      "https://h.example/app/x?y=a%26b%3Dc",
    );
    expect(urlAuthorityInputs("{{base_url}}/x?y={{v}}")).toEqual(["base_url"]);
  });

  it("a port or userinfo value is encoded, and both are authority inputs", () => {
    expect(url("https://h.example:{{port}}/x", { port: "443@evil.example" })).toBe(
      "https://h.example:443%40evil.example/x",
    );
    expect(urlAuthorityInputs("https://h.example:{{port}}/x")).toEqual(["port"]);
    const rendered = url("https://{{user}}@h.example/", { user: "evil.example/?" });
    expect(rendered).toBe("https://evil.example%2F%3F@h.example/");
    expect(new URL(rendered).host).toBe("h.example");
    expect(urlAuthorityInputs("https://{{user}}@h.example/")).toEqual(["user"]);
  });

  it("path segment, query component and fragment are each one encoded value", () => {
    const rendered = url("https://h.example/{{seg}}?q={{v}}#{{f}}", {
      seg: "a/b",
      v: "1&admin=1",
      f: "x#y",
    });
    expect(rendered).toBe("https://h.example/a%2Fb?q=1%26admin%3D1#x%23y");
    expect([...new URL(rendered).searchParams.keys()]).toEqual(["q"]);
    expect(urlAuthorityInputs("https://h.example/{{seg}}?q={{v}}#{{f}}")).toEqual([]);
  });
});

describe("substituteRequest — bodies", () => {
  const body = (template: string, contentType: string, inputs: Record<string, unknown>) =>
    substituteRequest(
      { url: "https://h.example/", headers: {}, body: template, contentType },
      inputs,
    ).body;

  it("bare JSON: a string is a JSON string whatever it spells; a typed value is its JSON", () => {
    const template = '{"a":{{a}},"b":{{b}},"c":{{c}},"d":{{d}},"e":{{e}},"n":{{n}},"t":{{t}}}';
    const inputs = {
      a: "1234",
      b: "true",
      c: "null",
      d: "0123",
      e: '1,"admin":true',
      n: 1234,
      t: true,
    };
    expect(JSON.parse(body(template, "application/json", inputs)!)).toEqual({
      a: "1234",
      b: "true",
      c: "null",
      d: "0123",
      e: '1,"admin":true',
      n: 1234,
      t: true,
    });
  });

  for (const type of ["text/json", "application/x-json", "application/vnd.api+json"]) {
    it(`${type} is JSON`, () => {
      const hostile = 'q","admin":true,"z":"';
      expect(JSON.parse(body('{"a":"{{a}}"}', type, { a: hostile })!)).toEqual({ a: hostile });
    });
  }

  it("a typed value in a form body is its JSON text, form-encoded", () => {
    const params = new URLSearchParams(
      body("n={{n}}&o={{o}}", "application/x-www-form-urlencoded", { n: 1234, o: { x: "a&b" } })!,
    );
    expect(params.get("n")).toBe("1234");
    expect(params.get("o")).toBe('{"x":"a&b"}');
    expect([...params.keys()]).toEqual(["n", "o"]);
  });

  it("an unterminated CDATA section still only splits `]]>`", () => {
    expect(body("<a><![CDATA[{{a}}", "application/xml", { a: "]]><b/>" })).toBe(
      "<a><![CDATA[]]]]><![CDATA[><b/>",
    );
  });
});

describe("substituteRequest — refusals name the field, never the value", () => {
  it("refuses CR/LF in a header and in a multipart body", () => {
    const header = () =>
      substituteRequest(
        { url: "https://h.example/", headers: { "X-Pw": "{{pw}}" }, body: undefined },
        { pw: "secret\r\nX-Admin: 1" },
      );
    expect(header).toThrow(UnencodableInputError);
    expect(header).not.toThrow(/secret/);
    expect(() =>
      substituteRequest(
        {
          url: "https://h.example/",
          headers: { "Content-Type": "multipart/form-data; boundary=B" },
          body: "--B\r\n\r\n{{pw}}\r\n--B--",
        },
        { pw: "x\r\n--B" },
      ),
    ).toThrow(UnencodableInputError);
  });

  it("refuses a Cookie header value outside cookie-octet, and only in a Cookie header", () => {
    const render = (name: string, value: string) =>
      substituteRequest(
        { url: "https://h.example/", headers: { [name]: "sid={{s}}" }, body: undefined },
        { s: value },
      ).headers[name];
    for (const bad of ["x; admin=1", "x,y", "x y", 'x"', "x\\y", "x\ty"]) {
      expect(() => render("Cookie", bad)).toThrow(UnencodableInputError);
    }
    expect(render("cookie", "abc-123_~!")).toBe("sid=abc-123_~!");
    expect(render("X-Other", "x; y")).toBe("sid=x; y");
  });
});
