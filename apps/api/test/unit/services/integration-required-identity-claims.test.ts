// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for AFPS §7.4 `auth.required_identity_claims` enforcement.
 *
 * `assertRequiredIdentityClaims` is the gate the OAuth2 + Login connect
 * strategies invoke between identity extraction and persistence. It refuses
 * connections whose resolved claim set is missing any claim the manifest
 * declares as required.
 *
 * Per spec §7.4, `required_identity_claims` enumerate **OIDC source-side**
 * claim names — the values referenced by `auth.identity_claims`, not the
 * AFPS-internal keys. The gate must reverse-resolve OIDC → AFPS via the
 * mapping before probing the claim bag.
 *
 * Pure function, no DB — exercises the gate directly with synthesized
 * manifests + claim bags.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { assertRequiredIdentityClaims } from "../../../src/services/integration-connections.ts";

function manifestWith({
  required,
  identityClaims,
}: {
  required?: string[];
  identityClaims?: Record<string, string>;
}): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    source: { kind: "api", api: {} },
    auths: {
      session: {
        type: "oauth2",
        delivery: { http: { in: "header", name: "Authorization", value: "Bearer x" } },
        ...(identityClaims ? { identity_claims: identityClaims } : {}),
        ...(required ? { required_identity_claims: required } : {}),
      },
    },
  } as unknown as IntegrationManifest;
}

// Backwards-compatible helper for the historical OIDC-keys-equal-AFPS-keys
// case (mapping `{ email: "email", sub: "sub" }`). The reverse-lookup
// resolves identically here — both keyspaces coincide.
function manifestWithRequired(required: string[] | undefined): IntegrationManifest {
  return manifestWith({
    ...(required ? { required } : {}),
    identityClaims: { email: "email", sub: "sub" },
  });
}

describe("assertRequiredIdentityClaims (AFPS §7.4)", () => {
  it("passes when manifest declares no required claims", () => {
    const m = manifestWithRequired(undefined);
    expect(() => assertRequiredIdentityClaims(m, "session", {})).not.toThrow();
  });

  it("passes when the required claim is present and non-empty", () => {
    const m = manifestWithRequired(["email"]);
    expect(() => assertRequiredIdentityClaims(m, "session", { email: "a@b.co" })).not.toThrow();
  });

  it("throws when a required claim is missing from the claim set", () => {
    const m = manifestWithRequired(["email"]);
    expect(() => assertRequiredIdentityClaims(m, "session", {})).toThrow(/'email'/);
  });

  it("throws when a required claim is present but empty-string (extractor miss)", () => {
    // readPath collapses missing JSONPath hits to "" — must be treated the
    // same as absent, otherwise a misconfigured extractor silently passes.
    const m = manifestWithRequired(["sub"]);
    expect(() => assertRequiredIdentityClaims(m, "session", { sub: "" })).toThrow(/'sub'/);
  });

  it("throws when a required claim is null/undefined", () => {
    const m = manifestWithRequired(["sub"]);
    expect(() =>
      assertRequiredIdentityClaims(m, "session", { sub: null as unknown as string }),
    ).toThrow(/'sub'/);
    expect(() => assertRequiredIdentityClaims(m, "session", { sub: undefined })).toThrow(/'sub'/);
  });

  it("lists every missing claim in a single error (not just the first)", () => {
    const m = manifestWithRequired(["email", "sub", "org_id"]);
    try {
      assertRequiredIdentityClaims(m, "session", { email: "a@b.co" });
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("'sub'");
      expect(msg).toContain("'org_id'");
      // The satisfied claim must NOT appear in the missing list.
      expect(msg).not.toContain("'email'");
    }
  });

  it("treats an empty required array as a no-op", () => {
    const m = manifestWithRequired([]);
    expect(() => assertRequiredIdentityClaims(m, "session", {})).not.toThrow();
  });
});

describe("assertRequiredIdentityClaims — OIDC keyspace resolution (§7.4 line 931)", () => {
  // Spec example: identity_claims maps an AFPS internal key to an OIDC claim
  // name. required_identity_claims references the OIDC claim — NOT the AFPS
  // key. The gate must reverse-lookup the mapping before probing the bag.
  it("passes when required OIDC claim is mapped to an AFPS key with a non-empty value", () => {
    const m = manifestWith({
      identityClaims: { account_id: "$.sub" },
      required: ["sub"],
    });
    expect(() =>
      assertRequiredIdentityClaims(m, "session", { account_id: "user-123" }),
    ).not.toThrow();
  });

  it("fails when required OIDC claim is mapped but the AFPS key carries an empty string", () => {
    const m = manifestWith({
      identityClaims: { account_id: "$.sub" },
      required: ["sub"],
    });
    expect(() => assertRequiredIdentityClaims(m, "session", { account_id: "" })).toThrow(/'sub'/);
  });

  it("fails when required OIDC claim is mapped but the AFPS key is absent from the bag", () => {
    const m = manifestWith({
      identityClaims: { account_id: "$.sub" },
      required: ["sub"],
    });
    expect(() => assertRequiredIdentityClaims(m, "session", {})).toThrow(/'sub'/);
  });

  it("falls back to direct bag lookup when identity_claims is undefined entirely", () => {
    // No mapping declared (engine-promoted claims path). The bag is keyed by
    // the OIDC/source claim name directly — the gate must accept that.
    const m = manifestWith({
      required: ["email"],
    });
    expect(() => assertRequiredIdentityClaims(m, "session", { email: "x@y.com" })).not.toThrow();
    expect(() => assertRequiredIdentityClaims(m, "session", {})).toThrow(/'email'/);
  });

  it("is satisfied when any of multiple AFPS keys mapped to the same OIDC claim is non-empty", () => {
    const m = manifestWith({
      identityClaims: { primary_email: "$.email", login_hint: "$.email" },
      required: ["email"],
    });
    // First mapping satisfied, second empty → PASS (any one is enough).
    expect(() =>
      assertRequiredIdentityClaims(m, "session", {
        primary_email: "x@y.com",
        login_hint: "",
      }),
    ).not.toThrow();
    // Both empty → FAIL.
    expect(() =>
      assertRequiredIdentityClaims(m, "session", {
        primary_email: "",
        login_hint: "",
      }),
    ).toThrow(/'email'/);
  });

  it("accepts the bare-string accessor form (no $. prefix) as identical to the JSONPath form", () => {
    // `"sub"` and `"$.sub"` are interchangeable per extractIdentity's
    // readPath() behaviour. The reverse-lookup must treat them the same.
    const m = manifestWith({
      identityClaims: { account_id: "sub" },
      required: ["sub"],
    });
    expect(() =>
      assertRequiredIdentityClaims(m, "session", { account_id: "user-123" }),
    ).not.toThrow();
  });

  it("ignores nested-path mappings for OIDC reverse-lookup but still checks the bag directly", () => {
    // `"$.user.email"` is a multi-segment path → not an OIDC claim name.
    // The reverse-lookup skips it, so the requirement falls through to the
    // direct-bag fallback. If the bag also lacks `email`, the gate fails.
    const m = manifestWith({
      identityClaims: { primary_email: "$.user.email" },
      required: ["email"],
    });
    expect(() => assertRequiredIdentityClaims(m, "session", { primary_email: "x@y.com" })).toThrow(
      /'email'/,
    );
    // Direct hit on `email` in the bag satisfies via the fallback.
    expect(() =>
      assertRequiredIdentityClaims(m, "session", {
        primary_email: "x@y.com",
        email: "x@y.com",
      }),
    ).not.toThrow();
  });
});
