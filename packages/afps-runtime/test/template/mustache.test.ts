// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { renderTemplate, validateTemplate } from "../../src/template/mustache.ts";

describe("renderTemplate", () => {
  it("substitutes a simple variable", () => {
    expect(renderTemplate("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });

  it("resolves dotted paths", () => {
    expect(renderTemplate("{{user.name}}", { user: { name: "Ada" } })).toBe("Ada");
  });

  it("renders missing variables as empty string", () => {
    expect(renderTemplate("[{{missing}}]", {})).toBe("[]");
  });

  it("does NOT HTML-escape (prompts are markdown, not HTML)", () => {
    expect(renderTemplate("{{raw}}", { raw: '<b>foo</b> & "bar"' })).toBe('<b>foo</b> & "bar"');
  });

  it("{{var}} and {{{var}}} behave identically", () => {
    const view = { x: "<em>hi</em>" };
    expect(renderTemplate("{{x}}", view)).toBe(renderTemplate("{{{x}}}", view));
  });

  it("iterates arrays via sections", () => {
    const tpl = "{{#items}}- {{.}}\n{{/items}}";
    const out = renderTemplate(tpl, { items: ["a", "b", "c"] });
    expect(out).toBe("- a\n- b\n- c\n");
  });

  it("renders an empty section when the array is empty", () => {
    expect(renderTemplate("pre{{#xs}}x{{/xs}}post", { xs: [] })).toBe("prepost");
  });

  it("renders an inverted section when the value is empty", () => {
    expect(renderTemplate("{{^xs}}none{{/xs}}", { xs: [] })).toBe("none");
    expect(renderTemplate("{{^xs}}none{{/xs}}", { xs: [1] })).toBe("");
  });

  it("supports nested object sections", () => {
    const tpl = "{{#user}}Name: {{name}}, Age: {{age}}{{/user}}";
    expect(renderTemplate(tpl, { user: { name: "Ada", age: 36 } })).toBe("Name: Ada, Age: 36");
  });

  it("never invokes functions reachable via the view (logic-less invariant)", () => {
    // The real guarantee: a function stored in the view is NOT called by
    // rendering. Mustache may stringify it, but the side effect never runs.
    let sideEffectRan = false;
    const view = {
      danger: () => {
        sideEffectRan = true;
        return "INJECTED";
      },
    };
    const out = renderTemplate("before {{danger}} after", view);
    expect(sideEffectRan).toBe(false);
    expect(out).not.toContain("INJECTED");
  });

  it("tolerates view: undefined / null without throwing", () => {
    expect(renderTemplate("static", undefined)).toBe("static");
    expect(renderTemplate("static", null)).toBe("static");
  });
});

describe("validateTemplate", () => {
  it("returns ok for a well-formed template", () => {
    expect(validateTemplate("Hello {{name}}")).toEqual({ ok: true });
  });

  it("returns ok for an empty template", () => {
    expect(validateTemplate("")).toEqual({ ok: true });
  });

  it("returns an error for an unclosed section", () => {
    const result = validateTemplate("{{#xs}}unterminated");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/xs|unclosed|section/i);
    }
  });

  it("returns an error for a stray closing tag", () => {
    const result = validateTemplate("plain {{/not-opened}}");
    expect(result.ok).toBe(false);
  });
});

describe("renderTemplate — non-string interpolation", () => {
  const view = {
    obj: { a: 1, b: { c: "x" } },
    list: ["a,b", "c"],
    str: "<em>hi</em>",
    items: [{ name: "one" }, { name: "two" }],
  };

  it("renders objects as JSON in {{x}}, {{{x}}} and {{&x}}", () => {
    const json = '{"a":1,"b":{"c":"x"}}';
    expect(renderTemplate("{{obj}}", view)).toBe(json);
    expect(renderTemplate("{{{obj}}}", view)).toBe(json);
    expect(renderTemplate("{{&obj}}", view)).toBe(json);
  });

  it("renders arrays as JSON in every interpolation form", () => {
    const json = '["a,b","c"]';
    expect(renderTemplate("{{list}}", view)).toBe(json);
    expect(renderTemplate("{{{list}}}", view)).toBe(json);
    expect(renderTemplate("{{&list}}", view)).toBe(json);
  });

  it("leaves strings unchanged in every interpolation form", () => {
    for (const tpl of ["{{str}}", "{{{str}}}", "{{&str}}"]) {
      expect(renderTemplate(tpl, view)).toBe("<em>hi</em>");
    }
  });

  it("renders missing values as empty in every interpolation form", () => {
    for (const tpl of ["[{{nope}}]", "[{{{nope}}}]", "[{{&nope}}]"]) {
      expect(renderTemplate(tpl, view)).toBe("[]");
    }
  });

  it("resolves dotted paths to objects", () => {
    expect(renderTemplate("{{input.o}}", { input: { o: { k: 1 } } })).toBe('{"k":1}');
  });

  it("still iterates arrays of objects in sections", () => {
    expect(renderTemplate("{{#items}}{{name}};{{/items}}", view)).toBe("one;two;");
  });

  it("still yields each string for {{.}} over an array of strings", () => {
    expect(renderTemplate("{{#list}}[{{.}}]{{/list}}", view)).toBe("[a,b][c]");
  });
});
