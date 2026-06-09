// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the security-critical MCP audience parser.
 *
 * The mint-time gate binds a token to exactly one org's canonical resource URI
 * (`getMcpOrgResourceUri`). `orgIdFromMcpAudience` is the inverse, and its
 * exact-match invariant is what stops a crafted `aud` — a sub-path, a
 * query/fragment/matrix-decorated variant, or a wrong-prefix URI — from being
 * read as a binding to an org and sidestepping audience confinement.
 */

import { describe, it, expect } from "bun:test";
import { getEnv } from "@appstrate/env";
import {
  getMcpOrgResourceUri,
  orgIdFromMcpAudience,
  extractOrgIdFromAudiences,
} from "../../audiences.ts";

// Derive the base the same way the parser does, so the test is independent of
// the concrete APP_URL the env happens to carry.
const base = `${getEnv().APP_URL.replace(/\/+$/, "")}/api/mcp/o`;

describe("orgIdFromMcpAudience", () => {
  it("round-trips the canonical per-org resource URI", () => {
    expect(orgIdFromMcpAudience(getMcpOrgResourceUri("org_abc"))).toBe("org_abc");
  });

  it("rejects a nested sub-path (no confinement bypass via extra segments)", () => {
    expect(orgIdFromMcpAudience(`${base}/org_abc/extra`)).toBeUndefined();
  });

  it("rejects query / fragment / matrix-decorated variants", () => {
    expect(orgIdFromMcpAudience(`${base}/org_abc?x=1`)).toBeUndefined();
    expect(orgIdFromMcpAudience(`${base}/org_abc#frag`)).toBeUndefined();
    expect(orgIdFromMcpAudience(`${base}/org_abc;v=2`)).toBeUndefined();
  });

  it("rejects the empty trailing segment", () => {
    expect(orgIdFromMcpAudience(`${base}/`)).toBeUndefined();
  });

  it("rejects non-MCP and wrong-prefix audiences", () => {
    expect(orgIdFromMcpAudience(`${getEnv().APP_URL}/api/auth`)).toBeUndefined();
    expect(orgIdFromMcpAudience("https://evil.example/api/mcp/o/org_abc")).toBeUndefined();
  });
});

describe("extractOrgIdFromAudiences", () => {
  it("returns the first org id among mixed (non-string included) entries", () => {
    const aud = ["https://example.test/other", 42, getMcpOrgResourceUri("org_xyz")];
    expect(extractOrgIdFromAudiences(aud)).toBe("org_xyz");
  });

  it("returns undefined when no entry names a per-org MCP resource", () => {
    expect(extractOrgIdFromAudiences([`${getEnv().APP_URL}/api/auth`, null, 7])).toBeUndefined();
  });
});
