// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the security-critical MCP audience parser.
 *
 * The mint-time gate binds a token to exactly one MCP resource URI — an org's
 * (`getMcpOrgResourceUri`) or a space's (`getMcpSpaceResourceUri`).
 * `parseMcpResourceUri` is the inverse, and its exact-match invariant is what
 * stops a crafted `aud` — a sub-path, a query/fragment/matrix-decorated
 * variant, a malformed space segment, or a wrong-prefix URI — from being read
 * as a binding and sidestepping audience confinement.
 */

import { describe, it, expect } from "bun:test";
import { getEnv } from "@appstrate/env";
import {
  addMcpOrgVerifyAudience,
  deriveMcpResourceUri,
  enclosingMcpResourceUris,
  getMcpOrgResourceUri,
  getMcpSpaceResourceUri,
  isEndUserVerifyAudience,
  mcpBindingFromAudiences,
  parseMcpResourceUri,
  removeMcpOrgVerifyAudience,
} from "../../src/lib/audiences.ts";

// Derive the base the same way the parser does, so the test is independent of
// the concrete APP_URL the env happens to carry.
const base = `${getEnv().APP_URL.replace(/\/+$/, "")}/api/mcp/o`;
const sid = `spc_${crypto.randomUUID()}`;

describe("parseMcpResourceUri", () => {
  it("round-trips the canonical per-org resource URI", () => {
    expect(parseMcpResourceUri(getMcpOrgResourceUri("org_abc"))).toEqual({ orgId: "org_abc" });
  });

  it("round-trips the canonical per-space resource URI", () => {
    expect(parseMcpResourceUri(getMcpSpaceResourceUri("org_abc", sid))).toEqual({
      orgId: "org_abc",
      spaceId: sid,
    });
  });

  it("rejects a malformed space segment or anything after it", () => {
    expect(parseMcpResourceUri(`${base}/org_abc/s/notaspace`)).toBeUndefined();
    expect(parseMcpResourceUri(`${base}/org_abc/s/${sid}/x`)).toBeUndefined();
    expect(parseMcpResourceUri(`${base}/org_abc/s/${sid}/`)).toBeUndefined();
  });

  it("rejects a nested sub-path (no confinement bypass via extra segments)", () => {
    expect(parseMcpResourceUri(`${base}/org_abc/x`)).toBeUndefined();
    expect(parseMcpResourceUri(`${base}/org_abc/extra/more`)).toBeUndefined();
  });

  it("rejects query / fragment / matrix-decorated variants", () => {
    expect(parseMcpResourceUri(`${base}/org_abc?x=1`)).toBeUndefined();
    expect(parseMcpResourceUri(`${base}/org_abc#frag`)).toBeUndefined();
    expect(parseMcpResourceUri(`${base}/org_abc;v=2`)).toBeUndefined();
    expect(parseMcpResourceUri(`${base}/org_abc/s/${sid}?x=1`)).toBeUndefined();
  });

  it("rejects the empty trailing segment", () => {
    expect(parseMcpResourceUri(`${base}/`)).toBeUndefined();
  });

  it("rejects non-MCP and wrong-prefix audiences", () => {
    expect(parseMcpResourceUri(`${getEnv().APP_URL}/api/auth`)).toBeUndefined();
    expect(parseMcpResourceUri("https://evil.example/api/mcp/o/org_abc")).toBeUndefined();
  });
});

describe("mcpBindingFromAudiences", () => {
  it("returns the first binding among mixed (non-string included) entries", () => {
    const aud = ["https://example.test/other", 42, getMcpSpaceResourceUri("org_xyz", sid)];
    expect(mcpBindingFromAudiences(aud)).toEqual({ orgId: "org_xyz", spaceId: sid });
  });

  it("returns undefined when no entry names an MCP resource", () => {
    expect(mcpBindingFromAudiences([`${getEnv().APP_URL}/api/auth`, null, 7])).toBeUndefined();
  });
});

describe("deriveMcpResourceUri", () => {
  it("maps the org and space endpoint paths to their resource URIs", () => {
    expect(deriveMcpResourceUri(`/api/mcp/o/org_abc/s/${sid}`)).toBe(
      getMcpSpaceResourceUri("org_abc", sid),
    );
    expect(deriveMcpResourceUri("/api/mcp/o/org_abc")).toBe(getMcpOrgResourceUri("org_abc"));
    expect(deriveMcpResourceUri("/api/mcp/o/org_abc/")).toBe(getMcpOrgResourceUri("org_abc"));
    expect(deriveMcpResourceUri(`/api/mcp/o/org_abc/s/${sid}/`)).toBe(
      getMcpSpaceResourceUri("org_abc", sid),
    );
  });

  it("addresses no resource for any other path under the prefix", () => {
    expect(deriveMcpResourceUri("/api/mcp/o/org_abc/other")).toBeUndefined();
    expect(deriveMcpResourceUri("/api/mcp/o/org_abc/s/notaspace")).toBeUndefined();
    expect(deriveMcpResourceUri(`/api/mcp/o/org_abc/s/${sid}/x`)).toBeUndefined();
    expect(deriveMcpResourceUri("/api/mcp/o/")).toBeUndefined();
    expect(deriveMcpResourceUri("/api/mcp/o/org_abc//")).toBeUndefined();
    expect(deriveMcpResourceUri("/api/mcp/o/org_abc/s/")).toBeUndefined();
    expect(deriveMcpResourceUri(`/api/mcp/o/org_abc/s/${sid}//`)).toBeUndefined();
    expect(deriveMcpResourceUri("/api/agents")).toBeUndefined();
  });
});

describe("enclosingMcpResourceUris", () => {
  it("a space resource is enclosed by its org resource", () => {
    expect(enclosingMcpResourceUris(getMcpSpaceResourceUri("org_abc", sid))).toEqual([
      getMcpOrgResourceUri("org_abc"),
    ]);
  });

  it("an org resource is enclosed by nothing", () => {
    expect(enclosingMcpResourceUris(getMcpOrgResourceUri("org_abc"))).toEqual([]);
  });
});

describe("isEndUserVerifyAudience", () => {
  it("accepts a space URI only while its org is in the verifier set", () => {
    const spaceUri = getMcpSpaceResourceUri("org_abc", sid);
    expect(isEndUserVerifyAudience(spaceUri)).toBe(false);
    addMcpOrgVerifyAudience("org_abc");
    expect(isEndUserVerifyAudience(spaceUri)).toBe(true);
    expect(isEndUserVerifyAudience(getMcpOrgResourceUri("org_abc"))).toBe(true);
    removeMcpOrgVerifyAudience("org_abc");
    expect(isEndUserVerifyAudience(spaceUri)).toBe(false);
  });

  it("accepts the platform base URI", () => {
    expect(isEndUserVerifyAudience(getEnv().APP_URL)).toBe(true);
  });
});
