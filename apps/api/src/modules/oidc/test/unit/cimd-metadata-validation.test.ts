// SPDX-License-Identifier: Apache-2.0

/**
 * What our authorization server admits as a CIMD client: the platform's
 * pre-fetch host gate, and an upstream non-regression guard that keeps the
 * canonical MCP connector client registrable.
 *
 * claude.ai publishes a Client ID Metadata Document that declares
 *
 *   "grant_types": ["authorization_code","refresh_token",
 *                   "urn:ietf:params:oauth:grant-type:jwt-bearer"]
 *
 * The extra `jwt-bearer` grant is declared, never used by the browser
 * authorization-code flow, and RFC 7591 §2 says `grant_types` enumerates what a
 * client *may* use: an AS that does not support a declared grant ignores it
 * rather than rejecting the client. `@better-auth/cimd` validates the shape and
 * imposes no grant-type ceiling.
 *
 * What is pinned here is that property: `validateCimdMetadata` — the exact
 * validator the plugin runs during client resolution, called with the same
 * options production leaves at their defaults — accepts that document. An
 * upstream that introduces a grant-type ceiling breaks this file instead of
 * breaking claude.ai in production.
 *
 * Error *messages* are upstream's and are deliberately not asserted; only the
 * verdict and the metadata the AS goes on to persist are ours to care about.
 */

import { describe, it, expect } from "bun:test";
import { validateCimdMetadata } from "@better-auth/cimd";
import { isCimdMetadataDocumentUrlAllowed } from "../../auth/plugins.ts";

const CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";

/** A claude.ai-shaped CIMD document, parameterized on grant_types. */
function cimdDoc(grantTypes?: unknown): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_name: "Claude",
    client_uri: "https://claude.ai",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(grantTypes === undefined ? {} : { grant_types: grantTypes }),
  };
}

describe("CIMD metadata validation", () => {
  it("accepts claude.ai's document, extra jwt-bearer grant and all", () => {
    const result = validateCimdMetadata(
      CLIENT_ID,
      cimdDoc([
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ]),
    );

    expect(result.valid).toBe(true);
    // The grants the browser flow needs survive into the persisted client.
    expect(result.metadata?.grant_types).toEqual(
      expect.arrayContaining(["authorization_code", "refresh_token"]),
    );
  });

  it("accepts a document declaring only the two supported grants", () => {
    const result = validateCimdMetadata(CLIENT_ID, cimdDoc(["authorization_code"]));

    expect(result.valid).toBe(true);
    expect(result.metadata?.grant_types).toEqual(["authorization_code"]);
  });

  it("accepts a document that omits grant_types (the field is optional)", () => {
    const result = validateCimdMetadata(CLIENT_ID, cimdDoc());

    expect(result.valid).toBe(true);
  });

  it("still rejects a malformed document", () => {
    // Negative control: acceptance above is a verdict, not a validator that
    // waves everything through. `grant_types` must be an array.
    const result = validateCimdMetadata(CLIENT_ID, cimdDoc("authorization_code"));

    expect(result.valid).toBe(false);
  });
});

describe("CIMD metadata-document URL gate", () => {
  it("refuses hosts on the platform denylist that upstream would let through", () => {
    // `sidecar` and `agent` are the run network's Docker aliases and
    // `host.docker.internal` the host escape hatch. None is an IP literal, so
    // upstream's public-routability check on the client_id URL accepts all
    // three — this gate is the only thing standing between a hostile
    // `client_id` and a request onto the run network.
    for (const host of ["sidecar", "agent", "host.docker.internal", "localhost"]) {
      expect(isCimdMetadataDocumentUrlAllowed(`https://${host}/client.json`)).toBe(false);
    }
  });

  it("refuses IP literals and cloud-metadata addresses", () => {
    for (const host of ["169.254.169.254", "10.0.0.1", "127.0.0.1", "metadata.google.internal"]) {
      expect(isCimdMetadataDocumentUrlAllowed(`https://${host}/client.json`)).toBe(false);
    }
  });

  it("refuses every malformed input rather than letting one through", () => {
    // Fail-closed is structural: the gate never throws, and every parse failure
    // inside it reads as "blocked".
    for (const url of ["", "https://[bad", "not a url", "file:///etc/passwd"]) {
      expect(isCimdMetadataDocumentUrlAllowed(url)).toBe(false);
    }
  });

  it("allows an ordinary public client_id URL", () => {
    // Positive control — the gate is a denylist, not a deny-all.
    expect(isCimdMetadataDocumentUrlAllowed(CLIENT_ID)).toBe(true);
  });
});
