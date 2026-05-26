// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the install-time warning collector (`collectConnectLoginWarnings`).
 *
 * Covers AFPS §7.7 corners the Appstrate login engine cannot evaluate:
 *   - Arazzo Selector Object `type: "xpath"`
 *   - Multi-value JSONPath selectors (wildcards / filters / slices / recursive descent)
 *   - Criterion `type: "xpath"`
 *
 * Pure function — no DB, no setup, just shape-checking on a manifest object.
 */

import { describe, it, expect } from "bun:test";
import {
  collectConnectLoginWarnings,
  collectMetaWarnings,
} from "../../../src/services/integration-install-warnings.ts";

function makeIntegrationManifest(authBody: unknown): Record<string, unknown> {
  return {
    type: "integration",
    name: "@test/example",
    version: "1.0.0",
    schema_version: "2.0",
    source: { kind: "local" },
    auths: { primary: authBody },
  };
}

describe("collectConnectLoginWarnings", () => {
  it("returns [] for non-integration manifests", () => {
    expect(collectConnectLoginWarnings({ type: "agent" })).toEqual([]);
    expect(collectConnectLoginWarnings({ type: "skill" })).toEqual([]);
    expect(collectConnectLoginWarnings({ type: "mcp-server" })).toEqual([]);
  });

  it("returns [] when integration declares no connect.login", () => {
    const manifest = makeIntegrationManifest({
      type: "custom",
      delivery: { http: { in: "header", name: "X-Token", value: "{$credential.token}" } },
    });
    expect(collectConnectLoginWarnings(manifest)).toEqual([]);
  });

  it("returns [] for supported selectors (jsonpath single-value, jsonpointer, runtime expr, AFPS extractors)", () => {
    const manifest = makeIntegrationManifest({
      type: "custom",
      delivery: { http: { in: "header", name: "X-Token", value: "{$credential.token}" } },
      connect: {
        login: {
          request: { method: "POST", url: "https://example.com/login" },
          outputs: {
            token: "$response.body#/token",
            session_id: { context: "$response.body", selector: "$.session.id", type: "jsonpath" },
            ptr_value: {
              context: "$response.body",
              selector: "/data/0/value",
              type: "jsonpointer",
            },
            cookie_val: { from: "cookie", name: "SESSION" },
          },
          success_criteria: [{ condition: "$statusCode == 200" }],
        },
      },
    });
    expect(collectConnectLoginWarnings(manifest)).toEqual([]);
  });

  it("warns on XPath Selector Object output", () => {
    const manifest = makeIntegrationManifest({
      type: "custom",
      delivery: { http: { in: "header", name: "X-Token", value: "{$credential.token}" } },
      connect: {
        login: {
          request: { method: "POST", url: "https://example.com/login" },
          outputs: {
            token: { context: "$response.body", selector: "//token/text()", type: "xpath" },
          },
        },
      },
    });
    const warnings = collectConnectLoginWarnings(manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("XPath selector not supported");
    expect(warnings[0]).toContain("auths.primary.connect.login.outputs.token");
  });

  it("warns on multi-value JSONPath (wildcards, filters, slices, recursive descent)", () => {
    const wildcardManifest = makeIntegrationManifest({
      type: "custom",
      delivery: { http: { in: "header", name: "X-Token", value: "{$credential.token}" } },
      connect: {
        login: {
          request: { method: "POST", url: "https://example.com/login" },
          outputs: {
            tokens: { context: "$response.body", selector: "$.items[*].token", type: "jsonpath" },
          },
        },
      },
    });
    const filterManifest = makeIntegrationManifest({
      type: "custom",
      delivery: { http: { in: "header", name: "X-Token", value: "{$credential.token}" } },
      connect: {
        login: {
          request: { method: "POST", url: "https://example.com/login" },
          outputs: {
            token: {
              context: "$response.body",
              selector: "$.items[?(@.active)].token",
              type: "jsonpath",
            },
          },
        },
      },
    });
    const recursiveManifest = makeIntegrationManifest({
      type: "custom",
      delivery: { http: { in: "header", name: "X-Token", value: "{$credential.token}" } },
      connect: {
        login: {
          request: { method: "POST", url: "https://example.com/login" },
          outputs: {
            token: { context: "$response.body", selector: "$..token", type: "jsonpath" },
          },
        },
      },
    });
    expect(collectConnectLoginWarnings(wildcardManifest)).toHaveLength(1);
    expect(collectConnectLoginWarnings(filterManifest)).toHaveLength(1);
    expect(collectConnectLoginWarnings(recursiveManifest)).toHaveLength(1);
    expect(collectConnectLoginWarnings(wildcardManifest)[0]).toContain("single-value subset");
  });

  it("warns on xpath success criteria type", () => {
    const manifest = makeIntegrationManifest({
      type: "custom",
      delivery: { http: { in: "header", name: "X-Token", value: "{$credential.token}" } },
      connect: {
        login: {
          request: { method: "POST", url: "https://example.com/login" },
          success_criteria: [{ condition: "/response/status[text()='ok']", type: "xpath" }],
          outputs: { token: "$response.body#/token" },
        },
      },
    });
    const warnings = collectConnectLoginWarnings(manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("xpath");
    expect(warnings[0]).toContain("success_criteria[0]");
  });

  it("does NOT warn on jsonpath / regex / simple criterion types (engine supports them)", () => {
    const manifest = makeIntegrationManifest({
      type: "custom",
      delivery: { http: { in: "header", name: "X-Token", value: "{$credential.token}" } },
      connect: {
        login: {
          request: { method: "POST", url: "https://example.com/login" },
          success_criteria: [
            { condition: "$statusCode == 200" },
            { condition: "$statusCode == 200", type: "simple" },
            { condition: "$.session.token", type: "jsonpath" },
            { condition: "ok", type: "regex" },
          ],
          outputs: { token: "$response.body#/token" },
        },
      },
    });
    expect(collectConnectLoginWarnings(manifest)).toEqual([]);
  });

  it("aggregates warnings across multiple auths", () => {
    const manifest: Record<string, unknown> = {
      type: "integration",
      name: "@test/multi",
      version: "1.0.0",
      schema_version: "2.0",
      source: { kind: "local" },
      auths: {
        primary: {
          type: "custom",
          delivery: { http: { in: "header", name: "X-Token", value: "{$credential.token}" } },
          connect: {
            login: {
              request: { method: "POST", url: "https://example.com/login" },
              outputs: {
                token: { context: "$response.body", selector: "//token", type: "xpath" },
              },
            },
          },
        },
        fallback: {
          type: "custom",
          delivery: { http: { in: "header", name: "X-Token", value: "{$credential.token}" } },
          connect: {
            login: {
              request: { method: "POST", url: "https://example.com/login2" },
              success_criteria: [{ condition: "true", type: "xpath" }],
              outputs: { token: "$response.body#/token" },
            },
          },
        },
      },
    };
    const warnings = collectConnectLoginWarnings(manifest);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("auths.primary"))).toBe(true);
    expect(warnings.some((w) => w.includes("auths.fallback"))).toBe(true);
  });
});

describe("collectMetaWarnings", () => {
  it("returns [] when manifest has no _meta", () => {
    expect(collectMetaWarnings({ type: "agent" })).toEqual([]);
    expect(collectMetaWarnings({ type: "skill", _meta: undefined })).toEqual([]);
  });

  it("returns [] when _meta is empty", () => {
    expect(collectMetaWarnings({ type: "agent", _meta: {} })).toEqual([]);
  });

  it("returns [] for well-formed namespaced _meta keys (Appendix B regex hits)", () => {
    const manifest = {
      type: "agent",
      _meta: {
        "dev.appstrate/foo": { hello: "world" },
        "dev.appstrate/token-budget": { limit: 1000 },
        "com.example.vendor/whatever": {},
      },
    };
    expect(collectMetaWarnings(manifest)).toEqual([]);
  });

  it("returns [] for bare identifier keys (Appendix B regex permits — reserved for MCP)", () => {
    // The Appendix B regex makes the namespace prefix optional. Bare keys
    // are reserved for MCP per §10 but the regex itself accepts them; the
    // hard reject for actual `mcp/` prefix happens upstream in the validator.
    const manifest = { type: "agent", _meta: { "bare-key": {} } };
    expect(collectMetaWarnings(manifest)).toEqual([]);
  });

  it("warns on malformed namespace keys (Appendix B regex miss)", () => {
    // "nodots/foo" — namespace requires at least one dot (reverse-DNS).
    const manifest = { type: "agent", _meta: { "nodots/foo": {} } };
    const warnings = collectMetaWarnings(manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("nodots/foo");
    expect(warnings[0]).toContain("META_NAMESPACE_KEY");
  });

  it("aggregates warnings across multiple malformed keys", () => {
    const manifest = {
      type: "skill",
      _meta: {
        "dev.appstrate/ok": {},
        "BadCase.example/foo": {}, // uppercase in namespace → fails regex
        "nodot/bar": {}, // no dot in namespace → fails regex
      },
    };
    const warnings = collectMetaWarnings(manifest);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("BadCase.example/foo"))).toBe(true);
    expect(warnings.some((w) => w.includes("nodot/bar"))).toBe(true);
  });

  it("handles non-object manifest inputs defensively", () => {
    expect(collectMetaWarnings(null)).toEqual([]);
    expect(collectMetaWarnings(undefined)).toEqual([]);
    expect(collectMetaWarnings("string")).toEqual([]);
    expect(collectMetaWarnings(42)).toEqual([]);
  });

  it("handles non-object _meta defensively", () => {
    expect(collectMetaWarnings({ _meta: "string" })).toEqual([]);
    expect(collectMetaWarnings({ _meta: null })).toEqual([]);
    expect(collectMetaWarnings({ _meta: 42 })).toEqual([]);
  });
});
