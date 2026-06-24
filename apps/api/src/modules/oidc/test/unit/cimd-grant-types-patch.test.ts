// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for the local patch of `@better-auth/cimd`
 * (`patches/@better-auth%2Fcimd@1.7.0-beta.4.patch`).
 *
 * Upstream's CIMD metadata validator rejected a Client ID Metadata Document
 * whenever its `grant_types` was NOT a subset of
 * `{authorization_code, refresh_token}` — a strict `.every()` check. claude.ai
 * publishes a CIMD document (the canonical MCP connector client) that declares
 *
 *   "grant_types": ["authorization_code","refresh_token",
 *                   "urn:ietf:params:oauth:grant-type:jwt-bearer"]
 *
 * The extra `jwt-bearer` grant (declared, never used by the browser auth-code
 * flow) tripped the subset check, so every claude.ai connection to our OAuth
 * authorization server failed at `/oauth2/authorize` with:
 *
 *   {"error":"invalid_client",
 *    "error_description":"grant_types must be a subset of [...]"}
 *
 * Per RFC 7591 §2, `grant_types` enumerates what a client *may* use; an AS that
 * does not support a declared grant should ignore it, not reject the client.
 * Our patch replaces the reject-on-superset behavior with a filter: unsupported
 * grants are dropped, and the client is rejected only if NOTHING supported
 * remains. This file pins that behavior so a Better Auth bump that silently
 * drops the patch fails loudly here.
 *
 * `validateCimdMetadata` mutates the passed `raw` object in place (the resolver
 * relies on this: it persists the same object as the client record), so we
 * assert both the validation verdict and the post-filter `grant_types`.
 */

import { describe, it, expect } from "bun:test";
import { validateCimdMetadata } from "@better-auth/cimd";

const CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const ORIGIN_BOUND = ["redirect_uris"];

/** A valid claude.ai-shaped CIMD document, parameterized on grant_types. */
function cimdDoc(grantTypes: unknown): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(grantTypes === undefined ? {} : { grant_types: grantTypes }),
  };
}

describe("@better-auth/cimd patch — grant_types filtering", () => {
  it("accepts claude.ai's document (extra jwt-bearer grant) and filters it out", () => {
    const doc = cimdDoc([
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ]);

    const result = validateCimdMetadata(CLIENT_ID, doc, ORIGIN_BOUND);

    expect(result.valid).toBe(true);
    // jwt-bearer dropped; supported grants preserved (order-independent).
    expect(new Set(doc.grant_types as string[])).toEqual(
      new Set(["authorization_code", "refresh_token"]),
    );
  });

  it("rejects a document whose grant_types are ALL unsupported", () => {
    const doc = cimdDoc(["client_credentials", "urn:ietf:params:oauth:grant-type:jwt-bearer"]);

    const result = validateCimdMetadata(CLIENT_ID, doc, ORIGIN_BOUND);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("grant_types must include at least one");
  });

  it("rejects a non-array grant_types", () => {
    const doc = cimdDoc("authorization_code");

    const result = validateCimdMetadata(CLIENT_ID, doc, ORIGIN_BOUND);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("grant_types must be an array");
  });

  it("accepts a document that omits grant_types (field is optional)", () => {
    const doc = cimdDoc(undefined);

    const result = validateCimdMetadata(CLIENT_ID, doc, ORIGIN_BOUND);

    expect(result.valid).toBe(true);
    expect("grant_types" in doc).toBe(false);
  });

  it("leaves a standard authorization_code + refresh_token document unchanged", () => {
    const doc = cimdDoc(["authorization_code", "refresh_token"]);

    const result = validateCimdMetadata(CLIENT_ID, doc, ORIGIN_BOUND);

    expect(result.valid).toBe(true);
    expect(doc.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });
});
