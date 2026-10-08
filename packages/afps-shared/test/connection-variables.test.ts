// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  hostVariableValue,
  isUrlTemplate,
  isVariableTemplate,
  parseUrlVariableValue,
  renderUrlTemplate,
  unrenderableUrlTemplateVariables,
  variableRefs,
} from "../src/connection-variables.ts";

describe("variableRefs / isVariableTemplate", () => {
  it("lists referenced names in order, deduplicated", () => {
    expect(variableRefs("{$variable.b}/{$variable.a}{$variable.b}{$credential.c}")).toEqual([
      "b",
      "a",
    ]);
  });

  it("follows VARIABLE_NAME_REGEX", () => {
    expect(variableRefs("{$variable.Base}{$variable.1x}{$variable.a-b}")).toEqual([]);
  });

  it("tells a variable template from anything else", () => {
    expect(isVariableTemplate("{$variable.base_url}/mcp")).toBe(true);
    expect(isVariableTemplate("{$credential.token}")).toBe(false);
    expect(isVariableTemplate(42)).toBe(false);
  });
});

describe("isUrlTemplate", () => {
  for (const template of [
    "{$variable.base_url}",
    "{$variable.base_url}/",
    "{$variable.base_url}/api/v4/mcp",
    "{$variable.base_url}/api/v4/",
    "https://{$variable.tenant}.example.com",
    "https://{$variable.tenant}.forge.example.com/mcp",
  ]) {
    it(`accepts ${template}`, () => expect(isUrlTemplate(template)).toBe(true));
  }

  for (const template of [
    "x{$variable.base_url}",
    "{$variable.base_url}mcp",
    "{$variable.base_url}/a/../b",
    "{$variable.base_url}//mcp",
    "{$variable.base_url}/mcp?x=1",
    "{$variable.base_url}/{$variable.path}",
    "http://{$variable.tenant}.example.com",
    "https://{$variable.tenant}",
    "https://{$variable.tenant}.example.123",
    "https://{$variable.tenant}.example.com:8443/mcp",
    "https://api.{$variable.tenant}.com",
    "https://example.com/mcp",
  ]) {
    it(`refuses ${template}`, () => expect(isUrlTemplate(template)).toBe(false));
  }
});

describe("renderUrlTemplate — URL form", () => {
  const mcp = "{$variable.base_url}/api/v4/mcp";

  for (const [value, expected] of [
    ["https://gitlab.example.com", "https://gitlab.example.com/api/v4/mcp"],
    ["https://gitlab.example.com/", "https://gitlab.example.com/api/v4/mcp"],
    ["https://example.com/gitlab", "https://example.com/gitlab/api/v4/mcp"],
    ["https://example.com/gitlab///", "https://example.com/gitlab/api/v4/mcp"],
    ["https://GitLab.Example.com:443/x/", "https://gitlab.example.com/x/api/v4/mcp"],
    ["https://gitlab.example.com:8443", "https://gitlab.example.com:8443/api/v4/mcp"],
    // https-only is the egress check's, which knows the hosts an operator trusts over http.
    ["http://localhost:8080", "http://localhost:8080/api/v4/mcp"],
  ] as const) {
    it(`renders ${JSON.stringify(value)}`, () => {
      expect(renderUrlTemplate(mcp, { base_url: value })).toBe(expected);
    });
  }

  it("renders a template without a path as the value's serialization", () => {
    const bare = "{$variable.base_url}";
    expect(renderUrlTemplate(bare, { base_url: "https://a.example.com" })).toBe(
      "https://a.example.com/",
    );
    expect(renderUrlTemplate(bare, { base_url: "https://a.example.com/x/" })).toBe(
      "https://a.example.com/x/",
    );
  });

  it("keeps a template path's trailing slash", () => {
    expect(
      renderUrlTemplate("{$variable.base_url}/mcp/", { base_url: "https://a.example.com/" }),
    ).toBe("https://a.example.com/mcp/");
  });

  for (const bad of [
    "gitlab.example.com",
    "ftp://gitlab.example.com",
    "https://user:pass@gitlab.example.com",
    "https://user@gitlab.example.com",
    "https://@gitlab.example.com",
    "https://gitlab.example.com/?a=1",
    "https://gitlab.example.com/?",
    "https://gitlab.example.com/#x",
    "https://gitlab.example.com/#",
    "https://gitlab.example.com/*",
    "https://*.example.com",
    "",
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(renderUrlTemplate(mcp, { base_url: bad })).toBeNull();
    });
  }

  it("refuses a missing, inherited or non-string value", () => {
    expect(renderUrlTemplate(mcp, {})).toBeNull();
    expect(renderUrlTemplate("{$variable.constructor}/x", {})).toBeNull();
    expect(renderUrlTemplate(mcp, { base_url: 1 } as unknown as Record<string, string>)).toBeNull();
  });
});

describe("renderUrlTemplate — host form", () => {
  const tenant = "https://{$variable.tenant}.forge.example.com/mcp";

  it("substitutes the lowercased labels", () => {
    expect(renderUrlTemplate(tenant, { tenant: "Acme" })).toBe(
      "https://acme.forge.example.com/mcp",
    );
    expect(renderUrlTemplate(tenant, { tenant: "eu-1.acme" })).toBe(
      "https://eu-1.acme.forge.example.com/mcp",
    );
    expect(renderUrlTemplate(tenant, { tenant: "a".repeat(63) })).toBe(
      `https://${"a".repeat(63)}.forge.example.com/mcp`,
    );
  });

  for (const bad of [
    "",
    "-acme",
    "acme-",
    "ac_me",
    "acme.",
    ".acme",
    "a..b",
    "acme.com/x",
    "acme:8443",
    "user@acme",
    "a".repeat(64),
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(renderUrlTemplate(tenant, { tenant: bad })).toBeNull();
    });
  }

  it("refuses a rendered host over 253 characters", () => {
    const suffix = ".forge.example.com".length;
    const labels = (n: number) => {
      const parts: string[] = [];
      while (n > 0) {
        const len = Math.min(63, n);
        parts.push("a".repeat(len));
        n -= len + 1;
      }
      return parts.join(".");
    };
    const fits = labels(253 - suffix);
    expect(fits.length + suffix).toBe(253);
    expect(renderUrlTemplate(tenant, { tenant: fits })).not.toBeNull();
    const over = labels(254 - suffix);
    expect(over.length + suffix).toBe(254);
    expect(renderUrlTemplate(tenant, { tenant: over })).toBeNull();
  });
});

describe("renderUrlTemplate — literals and malformed templates", () => {
  it("renders a literal URL as itself", () => {
    expect(renderUrlTemplate("https://mcp.example.com/mcp", {})).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  it("refuses a templated value outside both forms", () => {
    expect(
      renderUrlTemplate("https://example.com/{$variable.p}", { p: "https://a.example.com" }),
    ).toBeNull();
    expect(renderUrlTemplate("{$credential.url}/mcp", {})).toBeNull();
  });
});

describe("unrenderableUrlTemplateVariables", () => {
  it("is empty when the template renders, or is literal", () => {
    expect(
      unrenderableUrlTemplateVariables("{$variable.base_url}/mcp", {
        base_url: "https://a.example.com",
      }),
    ).toEqual([]);
    expect(unrenderableUrlTemplateVariables("https://example.com/mcp", {})).toEqual([]);
  });

  it("names the variable whose value the template refuses", () => {
    expect(
      unrenderableUrlTemplateVariables("{$variable.base_url}/mcp", { base_url: "nope" }),
    ).toEqual(["base_url"]);
    expect(unrenderableUrlTemplateVariables("https://{$variable.t}.example.com", {})).toEqual([
      "t",
    ]);
  });

  it("names every variable of a malformed template", () => {
    expect(
      unrenderableUrlTemplateVariables("{$variable.a}/{$variable.b}", {
        a: "https://a.example.com",
        b: "x",
      }),
    ).toEqual(["a", "b"]);
  });
});

describe("value rules", () => {
  it("parseUrlVariableValue keeps the path and refuses a query", () => {
    expect(parseUrlVariableValue("https://a.example.com/x")?.pathname).toBe("/x");
    expect(parseUrlVariableValue("https://a.example.com/x?")).toBeNull();
    expect(parseUrlVariableValue(undefined)).toBeNull();
  });

  it("hostVariableValue lowercases valid labels", () => {
    expect(hostVariableValue("ACME.eu")).toBe("acme.eu");
    expect(hostVariableValue("acme_eu")).toBeNull();
  });
});
