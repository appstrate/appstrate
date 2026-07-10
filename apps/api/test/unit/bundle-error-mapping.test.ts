// SPDX-License-Identifier: Apache-2.0

/**
 * toBundleApiError (#878) — every bundle-layer throw must reach the caller as
 * a coded RFC 9457 problem, never as a bare `500 internal_error`.
 *
 * The regression this pins: a run against a published version assembles its
 * bundle from stored artifacts (download → SRI check → signature policy →
 * closure walk). Only `DEPENDENCY_UNRESOLVED` used to be mapped; an integrity
 * mismatch, a signature rejection or a malformed archive escaped untyped and
 * the global handler turned them into an opaque 500 with no detail.
 */

import { describe, it, expect } from "bun:test";
import { BundleError } from "@appstrate/afps-runtime/bundle";
import { toBundleApiError } from "../../src/services/run-launcher/bundle-error-mapping.ts";
import { BundleSignatureError } from "../../src/services/run-launcher/bundle-signature-policy.ts";
import { ApiError } from "../../src/lib/errors.ts";

describe("toBundleApiError", () => {
  it("returns null for a non-bundle error so the caller rethrows it untouched", () => {
    expect(toBundleApiError(new Error("boom"))).toBeNull();
    expect(toBundleApiError(new TypeError("nope"))).toBeNull();
    expect(toBundleApiError("a string")).toBeNull();
    expect(toBundleApiError(null)).toBeNull();
    expect(toBundleApiError(undefined)).toBeNull();
  });

  it("does not swallow an ApiError thrown further down the stack", () => {
    const original = new ApiError({
      status: 403,
      code: "forbidden",
      title: "Forbidden",
      detail: "nope",
    });
    expect(toBundleApiError(original)).toBeNull();
  });

  describe("DEPENDENCY_UNRESOLVED", () => {
    it("maps to 422 and names every unresolved dependency plus the fix", () => {
      const err = new BundleError("DEPENDENCY_UNRESOLVED", "closure walk failed", {
        missing: [
          { name: "@acme/skill-x", versionSpec: "^2.0.0" },
          { name: "@acme/skill-y", versionSpec: "1.4.2" },
        ],
      });

      const mapped = toBundleApiError(err);

      expect(mapped).toBeInstanceOf(ApiError);
      expect(mapped!.status).toBe(422);
      expect(mapped!.code).toBe("dependency_unresolved");
      expect(mapped!.message).toContain("'@acme/skill-x@^2.0.0'");
      expect(mapped!.message).toContain("'@acme/skill-y@1.4.2'");
      expect(mapped!.message).toContain("dependency_overrides");
    });

    it("degrades to a generic phrase when `details.missing` is absent or empty", () => {
      for (const details of [undefined, {}, { missing: [] }]) {
        const mapped = toBundleApiError(new BundleError("DEPENDENCY_UNRESOLVED", "x", details));
        expect(mapped!.status).toBe(422);
        expect(mapped!.message).toContain("a declared dependency");
      }
    });
  });

  describe("INTEGRITY_MISMATCH", () => {
    // Stays a 500: the stored bytes no longer hash to the SRI recorded at
    // publish time, which is corruption or tampering — an operator fault, not
    // a malformed request. What changes is that it now carries a code and a
    // detail instead of being an opaque dead end.
    it("maps to a CODED 500 naming the offending artifact and the remedy", () => {
      const err = new BundleError(
        "INTEGRITY_MISMATCH",
        "Integrity check failed for @acme/skill-x@1.0.0",
        { packageId: "@acme/skill-x", version: "1.0.0" },
      );

      const mapped = toBundleApiError(err);

      expect(mapped!.status).toBe(500);
      expect(mapped!.code).toBe("bundle_integrity_mismatch");
      expect(mapped!.message).toContain("@acme/skill-x@1.0.0");
      expect(mapped!.message).toContain("Republish");
      // The pre-fix behavior: a bare `internal_error` with no actionable detail.
      expect(mapped!.code).not.toBe("internal_error");
    });
  });

  describe("BundleSignatureError", () => {
    it("maps to 422 naming the package, the policy reason and both escapes", () => {
      const err = new BundleSignatureError(
        "unsigned_required",
        "@acme/skill-x",
        "Bundle signature verification failed for @acme/skill-x: unsigned",
      );

      const mapped = toBundleApiError(err);

      expect(mapped!.status).toBe(422);
      expect(mapped!.code).toBe("bundle_signature_invalid");
      expect(mapped!.message).toContain("@acme/skill-x");
      expect(mapped!.message).toContain("unsigned_required");
      expect(mapped!.message).toContain("AFPS_SIGNATURE_POLICY");
    });
  });

  describe("every remaining BundleError code", () => {
    // Exhaustive over the runtime's public code union minus the three handled
    // above: none may fall through to the global handler's opaque 500.
    const codes = [
      "ARCHIVE_INVALID",
      "BUNDLE_JSON_MISSING",
      "BUNDLE_JSON_INVALID",
      "RECORD_MISSING",
      "RECORD_MALFORMED",
      "RECORD_MISMATCH",
      "VERSION_UNSUPPORTED",
      "LIMITS_EXCEEDED",
      "MANIFEST_SCHEMA",
      "TOOL_BUNDLE_FAILED",
    ] as const;

    for (const code of codes) {
      it(`maps ${code} to 422 bundle_invalid, carrying the code in the detail`, () => {
        const mapped = toBundleApiError(new BundleError(code, `failure detail for ${code}`));

        expect(mapped).toBeInstanceOf(ApiError);
        expect(mapped!.status).toBe(422);
        expect(mapped!.code).toBe("bundle_invalid");
        expect(mapped!.message).toContain(code);
        expect(mapped!.message).toContain(`failure detail for ${code}`);
      });
    }
  });
});
