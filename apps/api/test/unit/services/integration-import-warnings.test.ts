// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { collectMetaWarnings } from "../../../src/services/integration-import-warnings.ts";

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
