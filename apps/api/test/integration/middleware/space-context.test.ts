// SPDX-License-Identifier: Apache-2.0

/**
 * `X-Space-Id` shape enforcement, end to end.
 *
 * The unit tests in `test/unit/lib/ids.test.ts` pin `assertSpaceId` itself.
 * These pin that a request actually reaches it, and reaches it BEFORE the
 * `spaces` lookup — a wrong-shaped id must be answered with a 400, not a 404
 * ("no such space", which reads like a client mistake about a well-formed id).
 *
 * `spc_`-prefixed-but-malformed ids are covered here too: they are the cases
 * that discriminate the strict regex from the `/^spc_.+/` widening its
 * docblock forbids.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { prefixedId } from "../../../src/lib/ids.ts";

const app = getTestApp();

/** A retired-prefix id whose UUID half is perfectly well-formed. */
const WRONG_PREFIX_ID = "app_2f1c6d84-9a52-4f2b-b1a7-0c9d3e5f7a10";

/**
 * `spc_`-prefixed ids the strict regex rejects and `/^spc_.+/` would accept.
 * A canonical id of the same org would 200; these must 400 on shape.
 */
const MALFORMED_SPC_IDS = [
  "spc_1",
  "spc_2f1c6d849a524f2bb1a70c9d3e5f7a10",
  "spc_2F1C6D84-9A52-4F2B-B1A7-0C9D3E5F7A10",
  "spc_2f1c6d84-9a52-4f2b-0c9d3e5f7a10",
];

describe("space-context middleware — X-Space-Id shape", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("accepts the org's canonical space id", async () => {
    const res = await app.request("/api/agents", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
  });

  it("400s a wrong-prefix id on shape — not a 404 from the spaces lookup", async () => {
    const res = await app.request("/api/agents", {
      headers: authHeaders(ctx, { "X-Space-Id": WRONG_PREFIX_ID }),
    });

    // 404 would be the answer for a well-formed id that does not exist. This
    // one never reaches the lookup: the shape guard answers first.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: string; param?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.param).toBe("space_id");
    expect(body.detail).toContain("Malformed");
    // No rename, no migration: the platform does not recognise `app_` at all.
    expect(body.detail).not.toContain("retired");
    expect(body.detail).not.toContain("migration");
  });

  for (const id of MALFORMED_SPC_IDS) {
    it(`400s the malformed space id '${id}'`, async () => {
      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx, { "X-Space-Id": id }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; detail: string };
      expect(body.code).toBe("invalid_request");
      expect(body.detail).toContain("Malformed space id");
      expect(body.detail).toContain("canonical UUID");
      // Not the migration diagnostic — the prefix is current, the id is junk.
      expect(body.detail).not.toContain("retired");
    });
  }

  it("404s a canonical id that belongs to no space in this org", async () => {
    const res = await app.request("/api/agents", {
      headers: authHeaders(ctx, { "X-Space-Id": prefixedId("spc") }),
    });
    expect(res.status).toBe(404);
  });
});
