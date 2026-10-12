// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  RequestTemplateError,
  substituteRequest,
  UnencodableInputError,
} from "../../src/resolvers/request-template.ts";

const url = (template: string, inputs: Record<string, unknown>) =>
  substituteRequest({ url: template, headers: {}, body: undefined }, inputs).url;

describe("substituteRequest — URL", () => {
  it("a placeholder after a literal host is encoded whole: it cannot open a path or a query", () => {
    expect(url("https://h.example{{p}}", { p: "/login?admin=1#" })).toBe(
      "https://h.example%2Flogin%3Fadmin%3D1%23",
    );
  });

  it("a leading base URL is spliced as is; a placeholder right after it is encoded", () => {
    expect(url("{{base}}{{path}}", { base: "https://h.example", path: "/login?admin=1&x=" })).toBe(
      "https://h.example%2Flogin%3Fadmin%3D1%26x%3D",
    );
    expect(url("{{base_url}}/x?y={{v}}", { base_url: "https://h.example/app", v: "a&b=c" })).toBe(
      "https://h.example/app/x?y=a%26b%3Dc",
    );
  });

  it("a port or userinfo value is encoded", () => {
    expect(url("https://h.example:{{port}}/x", { port: "443@evil.example" })).toBe(
      "https://h.example:443%40evil.example/x",
    );
    const rendered = url("https://{{user}}@h.example/", { user: "evil.example/?" });
    expect(rendered).toBe("https://evil.example%2F%3F@h.example/");
    expect(new URL(rendered).host).toBe("h.example");
  });

  it("path segment, query component and fragment are each one encoded value", () => {
    const rendered = url("https://h.example/{{seg}}?q={{v}}#{{f}}", {
      seg: "a/b",
      v: "1&admin=1",
      f: "x#y",
    });
    expect(rendered).toBe("https://h.example/a%2Fb?q=1%26admin%3D1#x%23y");
    expect([...new URL(rendered).searchParams.keys()]).toEqual(["q"]);
  });

  it("refuses a path segment a value renders as a dot segment or empty", () => {
    for (const seg of [".", "..", ""]) {
      expect(() => url("https://h.example/users/{{seg}}/keys", { seg })).toThrow(
        UnencodableInputError,
      );
      expect(() => url("{{base}}/users/{{seg}}", { base: "https://h.example", seg })).toThrow(
        UnencodableInputError,
      );
      expect(url("https://h.example/users?q={{seg}}#{{seg}}", { seg })).toBe(
        `https://h.example/users?q=${seg}#${seg}`,
      );
    }
    expect(() => url("https://h.example/a/.{{x}}/b", { x: "" })).toThrow(UnencodableInputError);
    expect(() => url("https://h.example/a/.{{x}}/b", { x: "." })).toThrow(UnencodableInputError);
    expect(() => url("https://h.example/a/%2E{{x}}/b", { x: "." })).toThrow(UnencodableInputError);
    expect(() => url("https://h.example/a/{{x}}{{y}}", { x: ".", y: "." })).toThrow(
      UnencodableInputError,
    );
  });

  it("judges the rendered segment, not the value: a dot value inside a longer segment is sent", () => {
    expect(url("https://h.example/a/x{{v}}y", { v: ".." })).toBe("https://h.example/a/x..y");
    expect(url("https://h.example/v{{seg}}/x", { seg: "1.2" })).toBe("https://h.example/v1.2/x");
    expect(url("https://h.example/a/{{v}}.json", { v: "" })).toBe("https://h.example/a/.json");
  });

  it("a host or port placeholder is no path segment", () => {
    expect(url("https://{{h}}example.com/x", { h: "" })).toBe("https://example.com/x");
    expect(url("https://h.example:{{port}}", { port: "" })).toBe("https://h.example:");
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

  it("form: each value is one WHATWG form component, never a separator", () => {
    const encoded = body("u={{u}}&p={{p}}", "application/x-www-form-urlencoded", {
      u: "a b&admin=1",
      p: "p&ss=w+rd %x",
    })!;
    expect(encoded).toBe("u=a+b%26admin%3D1&p=p%26ss%3Dw%2Brd+%25x");
    expect([...new URLSearchParams(encoded).keys()]).toEqual(["u", "p"]);
  });

  it("the body's media type is its Content-Type header's, any case, parameters ignored", () => {
    const { body: encoded } = substituteRequest(
      {
        url: "https://h.example/",
        headers: { "content-TYPE": "Application/X-WWW-Form-Urlencoded; charset=utf-8" },
        body: "p={{p}}",
        contentType: "text/plain",
      },
      { p: "a&b" },
    );
    expect(encoded).toBe("p=a%26b");
  });

  it("XML: a value is entity-escaped, and only `]]>` is split inside CDATA", () => {
    const template = '<l u="{{u}}"><p>{{p}}</p><c><![CDATA[{{p}}]]></c></l>';
    expect(body(template, "text/xml", { u: 'x"y', p: "</p><admin/>&]]>" })).toBe(
      '<l u="x&quot;y"><p>&lt;/p&gt;&lt;admin/&gt;&amp;]]&gt;</p>' +
        "<c><![CDATA[</p><admin/>&]]]]><![CDATA[>]]></c></l>",
    );
  });

  it("text/plain, declared, takes the value as is", () => {
    expect(body("p={{p}}", "text/plain; charset=utf-8", { p: "a&b" })).toBe("p=a&b");
  });

  it("refuses to substitute a body whose media type has no encoder, naming the type only", () => {
    const hostile = '","admin":true,"z":"';
    const render = (headers: Record<string, string>) => () =>
      substituteRequest(
        { url: "https://h.example/", headers, body: '{"a":"{{t}}"}' },
        { t: hostile, ct: "application/graphql" },
      );
    const unencodable: Record<string, string>[] = [{}, { "Content-Type": "application/graphql" }];
    for (const headers of unencodable) {
      expect(render(headers)).toThrow(RequestTemplateError);
      expect(render(headers)).not.toThrow(hostile);
    }
    expect(render({ "Content-Type": "application/graphql" })).toThrow("application/graphql");
    expect(render({ "Content-Type": "{{ct}}" })).toThrow(RequestTemplateError);
    expect(render({ "Content-Type": "{{ct}}" })).not.toThrow("graphql");
    expect(render({ "Content-Type": "multipart/form-data" })).toThrow(RequestTemplateError);
  });

  it("leaves a body with no placeholder of its inputs untouched, whatever its media type", () => {
    for (const template of ['{"a":"b"}', "{{other}} & <x>"]) {
      expect(
        substituteRequest({ url: "https://h.example/", headers: {}, body: template }, { t: "v" })
          .body,
      ).toBe(template);
    }
  });

  it("application/x-ndjson is JSON, one value per line", () => {
    const hostile = 'a"\n{"admin":true}';
    const rendered = body('{"a":"{{a}}"}\n{"b":{{a}}}', "application/x-ndjson", { a: hostile })!;
    expect(rendered.split("\n").map((line) => JSON.parse(line))).toEqual([
      { a: hostile },
      { b: hostile },
    ]);
  });

  it("refuses a Content-Type that is itself a placeholder: a value would pick the encoder", () => {
    expect(() =>
      substituteRequest(
        { url: "https://h.example/", headers: { "Content-Type": "{{ct}}" }, body: '{"a":"{{a}}"}' },
        { ct: "application/json", a: "v" },
      ),
    ).toThrow(RequestTemplateError);
  });

  it("XML: a comment holding `<![CDATA[` opens no CDATA section", () => {
    expect(body("<!-- <![CDATA[ --><a>{{x}}</a>", "application/xml", { x: "</a><admin/>" })).toBe(
      "<!-- <![CDATA[ --><a>&lt;/a&gt;&lt;admin/&gt;</a>",
    );
    expect(body("<![CDATA[ <!-- {{x}} ]]>", "application/xml", { x: "<b/>" })).toBe(
      "<![CDATA[ <!-- <b/> ]]>",
    );
  });

  describe("multipart", () => {
    const part = (template: string, x: string, type = "multipart/form-data; boundary=B") =>
      substituteRequest(
        { url: "https://h.example/", headers: { "Content-Type": type }, body: template },
        { x },
      ).body;
    const content = '--B\r\nContent-Disposition: form-data; name="f"\r\n\r\n{{x}}\r\n--B--';
    const header =
      '--B\r\nContent-Disposition: form-data; name="f"; filename="{{x}}"\r\n\r\nv\r\n--B--';

    it("a part's content takes a value as is", () => {
      expect(part(content, 'a "b" \\ --C')).toContain('\r\n\r\na "b" \\ --C\r\n--B--');
      expect(part(header, "a b.txt")).toContain('filename="a b.txt"');
    });

    it("refuses a value holding the boundary delimiter, quoted boundary included", () => {
      expect(() => part(content, "--B--")).toThrow(UnencodableInputError);
      expect(() => part(content, "x --B")).toThrow(UnencodableInputError);
      expect(() => part(content, "--B", 'multipart/form-data; boundary="B"')).toThrow(
        UnencodableInputError,
      );
    });

    it("refuses a quote or a backslash in a value inside a part header's quoted string", () => {
      for (const x of ['a"; name="admin', "a\\"]) {
        expect(() => part(header, x)).toThrow(UnencodableInputError);
      }
    });

    it("refuses a part header whose placeholder sits outside a quoted string, whatever the value", () => {
      const bare = (line: string) => () => part(`--B\r\n${line}\r\n\r\nv\r\n--B--`, "ok");
      for (const line of [
        "Content-Disposition: form-data; name={{x}}",
        "Content-Type: {{x}}",
        'Content-Disposition: form-data; name="a"{{x}}',
        "{{x}}: v",
      ]) {
        expect(bare(line)).toThrow(RequestTemplateError);
      }
      expect(() => part("--B{{x}}\r\n\r\nv\r\n--B--", "ok")).toThrow(RequestTemplateError);
    });
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

  it("sends a header value that is a field value as is", () => {
    expect(
      substituteRequest(
        { url: "https://h.example/", headers: { Authorization: "Basic {{t}}" }, body: undefined },
        { t: "a b=c&d" },
      ).headers.Authorization,
    ).toBe("Basic a b=c&d");
  });

  it("refuses a value that is not well-formed Unicode, wherever it sits", () => {
    expect(() =>
      substituteRequest(
        { url: "https://h.example/?p={{p}}", headers: {}, body: undefined },
        { p: "a\uD800b" },
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
