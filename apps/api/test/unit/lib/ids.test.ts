// SPDX-License-Identifier: Apache-2.0

/**
 * `SPACE_ID_RE` / `assertSpaceId` — the shape guard that makes a half-finished
 * `app_` → `spc_` data migration fail loudly instead of working in silence.
 *
 * The guard has two branches and they are NOT interchangeable, which is what
 * these tests pin:
 *   - a retired `app_` id must name the retired prefix and tell the operator
 *     the id migration has not run on this deployment;
 *   - anything else malformed must say so, and must NOT claim the deployment
 *     holds pre-rename data.
 *
 * The malformed cases below are the guard's whole reason for being strict:
 * widening `SPACE_ID_RE` to `/^spc_.+/` — the widening its own docblock forbids
 * by name — makes every one of them legal, so each is a live control on that
 * regex, not decoration.
 */

import { describe, it, expect } from "bun:test";
import { ApiError } from "@appstrate/core/api-errors";
import { SPACE_ID_RE, assertSpaceId, prefixedId } from "../../../src/lib/ids.ts";

/** Run `assertSpaceId` and return the `ApiError` it threw. Fails if it did not throw. */
function captureThrow(id: string, param?: string): ApiError {
  try {
    assertSpaceId(id, param);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error(`assertSpaceId accepted '${id}' — expected it to throw`);
}

describe("SPACE_ID_RE", () => {
  it("matches exactly what prefixedId('spc') mints", () => {
    for (let i = 0; i < 20; i++) {
      expect(SPACE_ID_RE.test(prefixedId("spc"))).toBe(true);
    }
  });

  const rejected: Array<[string, string]> = [
    ["retired prefix", "app_2f1c6d84-9a52-4f2b-b1a7-0c9d3e5f7a10"],
    ["truncated id", "spc_1"],
    ["dashless slice of a UUID", "spc_2f1c6d849a524f2bb1a70c9d3e5f7a10"],
    ["uppercase hex", "spc_2F1C6D84-9A52-4F2B-B1A7-0C9D3E5F7A10"],
    ["missing segment", "spc_2f1c6d84-9a52-4f2b-0c9d3e5f7a10"],
    ["prefix only", "spc_"],
    ["no prefix", "2f1c6d84-9a52-4f2b-b1a7-0c9d3e5f7a10"],
    ["trailing junk", "spc_2f1c6d84-9a52-4f2b-b1a7-0c9d3e5f7a10x"],
    ["leading junk", "xspc_2f1c6d84-9a52-4f2b-b1a7-0c9d3e5f7a10"],
    ["empty", ""],
  ];

  for (const [label, id] of rejected) {
    it(`rejects ${label}: '${id}'`, () => {
      expect(SPACE_ID_RE.test(id)).toBe(false);
    });
  }
});

describe("assertSpaceId", () => {
  it("accepts a canonical prefixedId('spc') value", () => {
    expect(() => assertSpaceId(prefixedId("spc"))).not.toThrow();
  });

  describe("retired `app_` prefix", () => {
    const retired = "app_2f1c6d84-9a52-4f2b-b1a7-0c9d3e5f7a10";

    it("throws a 400 naming the retired prefix and the migration", () => {
      const err = captureThrow(retired);
      expect(err.status).toBe(400);
      expect(err.code).toBe("invalid_request");
      expect(err.message).toContain(retired);
      expect(err.message).toContain("app_");
      expect(err.message).toContain("retired");
      expect(err.message).toContain("migration");
      // The operator-facing half: this is un-migrated DATA, not a bad client.
      expect(err.message).toContain("pre-rename data");
    });

    it("does NOT reuse the generic malformed wording", () => {
      expect(captureThrow(retired).message).not.toContain("Malformed");
    });

    it("still names the retired prefix when the rest of the id is garbage", () => {
      expect(captureThrow("app_nope").message).toContain("retired");
    });

    it("reports the field the id arrived on", () => {
      expect(captureThrow(retired, "X-Space-Id").param).toBe("X-Space-Id");
      expect(captureThrow(retired).param).toBe("space_id");
    });
  });

  describe("malformed ids", () => {
    // Every entry here is accepted by the forbidden `/^spc_.+/` widening except
    // the two that do not start with `spc_`.
    const malformed = [
      "spc_1",
      "spc_2f1c6d849a524f2bb1a70c9d3e5f7a10",
      "spc_2F1C6D84-9A52-4F2B-B1A7-0C9D3E5F7A10",
      "spc_2f1c6d84-9a52-4f2b-0c9d3e5f7a10",
      "spc_",
      "spc_ 2f1c6d84-9a52-4f2b-b1a7-0c9d3e5f7a10",
      "not-an-id",
      "2f1c6d84-9a52-4f2b-b1a7-0c9d3e5f7a10",
    ];

    for (const id of malformed) {
      it(`rejects '${id}' as malformed`, () => {
        const err = captureThrow(id);
        expect(err.status).toBe(400);
        expect(err.code).toBe("invalid_request");
        expect(err.message).toContain("Malformed space id");
        expect(err.message).toContain("canonical UUID");
        expect(err.message).toContain(id);
        // A malformed id must NOT be reported as un-migrated data — that
        // sends an operator looking for a migration that already ran.
        expect(err.message).not.toContain("migration");
      });
    }

    it("reports the field the id arrived on", () => {
      expect(captureThrow("spc_1", "spaceId").param).toBe("spaceId");
      expect(captureThrow("spc_1").param).toBe("space_id");
    });
  });
});
