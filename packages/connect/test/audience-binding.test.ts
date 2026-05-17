// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the RFC 8707 audience-binding helpers. Pure functions,
 * no I/O — proves the wire-shape contract callers in token-refresh +
 * oauth.ts can rely on without standing up a fake AS.
 */

import { describe, it, expect } from "bun:test";
import {
  appendResourceToTokenBody,
  buildAuthorizeResourceQuery,
  categorizeAudienceResponse,
} from "../src/audience-binding.ts";

describe("appendResourceToTokenBody — URLSearchParams overload", () => {
  it("appends a single resource and preserves prior params", () => {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt" });
    const out = appendResourceToTokenBody(body, "https://gmail.googleapis.com");
    expect(out).toBe(body); // in-place
    expect(out.get("grant_type")).toBe("refresh_token");
    expect(out.get("refresh_token")).toBe("rt");
    expect(out.get("resource")).toBe("https://gmail.googleapis.com");
  });

  it("appends multiple resources as repeated keys (RFC 8707 §2)", () => {
    const body = new URLSearchParams();
    appendResourceToTokenBody(body, ["https://a.example", "https://b.example"]);
    expect(body.getAll("resource")).toEqual(["https://a.example", "https://b.example"]);
  });

  it("is a no-op for undefined / empty / whitespace audience", () => {
    const body = new URLSearchParams({ grant_type: "refresh_token" });
    appendResourceToTokenBody(body, undefined);
    appendResourceToTokenBody(body, "");
    appendResourceToTokenBody(body, "   ");
    appendResourceToTokenBody(body, []);
    expect(body.has("resource")).toBe(false);
    expect(body.get("grant_type")).toBe("refresh_token");
  });

  it("trims surrounding whitespace from audiences", () => {
    const body = new URLSearchParams();
    appendResourceToTokenBody(body, "  https://api.example  ");
    expect(body.get("resource")).toBe("https://api.example");
  });
});

describe("appendResourceToTokenBody — record overload", () => {
  it("returns a new record without mutating the input", () => {
    const input = { grant_type: "refresh_token", refresh_token: "rt" };
    const out = appendResourceToTokenBody(input, "https://api.example");
    expect(out).not.toBe(input);
    expect(input).toEqual({ grant_type: "refresh_token", refresh_token: "rt" });
    expect(out).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt",
      resource: "https://api.example",
    });
  });

  it("rejects multi-resource against a record (repeated keys impossible)", () => {
    expect(() => appendResourceToTokenBody({}, ["https://a", "https://b"])).toThrow(
      /multiple audiences require URLSearchParams/,
    );
  });

  it("is a no-op (returns input) for undefined audience", () => {
    const input = { x: "y" };
    const out = appendResourceToTokenBody(input, undefined);
    expect(out).toBe(input);
  });
});

describe("buildAuthorizeResourceQuery", () => {
  it("URL-encodes the audience value", () => {
    expect(buildAuthorizeResourceQuery("https://api.example/v1/resource?id=42")).toBe(
      "&resource=https%3A%2F%2Fapi.example%2Fv1%2Fresource%3Fid%3D42",
    );
  });

  it("concatenates multiple resources", () => {
    expect(buildAuthorizeResourceQuery(["https://a", "https://b"])).toBe(
      "&resource=https%3A%2F%2Fa&resource=https%3A%2F%2Fb",
    );
  });

  it("returns the empty string for empty audience (safe to concat)", () => {
    expect(buildAuthorizeResourceQuery(undefined)).toBe("");
    expect(buildAuthorizeResourceQuery("")).toBe("");
    expect(buildAuthorizeResourceQuery([])).toBe("");
  });
});

describe("categorizeAudienceResponse", () => {
  it("categorises a successful response (no body) as accepted-or-no-op", () => {
    expect(categorizeAudienceResponse(null)).toBe("accepted-or-no-op");
    expect(categorizeAudienceResponse(undefined)).toBe("accepted-or-no-op");
    expect(categorizeAudienceResponse({})).toBe("accepted-or-no-op");
  });

  it("flags invalid_target per RFC 8707 §4", () => {
    expect(
      categorizeAudienceResponse({
        error: "invalid_target",
        error_description: "audience not allowed for this client",
      }),
    ).toBe("invalid-target");
  });

  it("returns other-error for non-RFC-8707 OAuth errors", () => {
    expect(categorizeAudienceResponse({ error: "invalid_grant" })).toBe("other-error");
    expect(categorizeAudienceResponse({ error: "invalid_scope" })).toBe("other-error");
    expect(categorizeAudienceResponse({ error: "server_error" })).toBe("other-error");
  });
});
