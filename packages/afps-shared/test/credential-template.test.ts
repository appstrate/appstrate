// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  credentialTemplateRefs,
  parseCredentialRef,
  renderCredentialTemplate,
  templateExpressions,
  unsupportedTemplateExpressions,
} from "../src/credential-template.ts";

describe("renderCredentialTemplate", () => {
  it("renders {$credential.<field>} refs, never a value's own expressions", () => {
    expect(renderCredentialTemplate("x {$credential.a}", { a: "{$credential.b}", b: "v" })).toBe(
      "x {$credential.b}",
    );
  });

  it("renders a missing or inherited field empty", () => {
    expect(renderCredentialTemplate("[{$credential.x}{$credential.constructor}]", {})).toBe("[]");
  });

  for (const expr of ["{$outputs.token}", "{$credential.a-b}", "{$inputs.password}", "{$}"]) {
    it(`throws on ${expr} rather than rendering it literally`, () => {
      expect(() => renderCredentialTemplate(`Bearer ${expr}`, { token: "t" })).toThrow(
        `unsupported template expression '${expr}'`,
      );
    });
  }
});

describe("template expressions", () => {
  it("parseCredentialRef accepts exactly one whole reference", () => {
    expect(parseCredentialRef("{$credential.access_token}")).toBe("access_token");
    expect(parseCredentialRef("x{$credential.a}")).toBeNull();
    expect(parseCredentialRef("{$outputs.a}")).toBeNull();
    expect(parseCredentialRef("access_token")).toBeNull();
  });

  it("lists every {$…} expression, and those that are not credential refs", () => {
    const t = "{$credential.a}:{$outputs.b}/{$credential.a}{{c}}";
    expect(templateExpressions(t)).toEqual(["{$credential.a}", "{$outputs.b}"]);
    expect(unsupportedTemplateExpressions(t)).toEqual(["{$outputs.b}"]);
  });
});

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
