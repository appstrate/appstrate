// SPDX-License-Identifier: Apache-2.0

/**
 * `Idempotency-Key` honesty guard — behavioural tests.
 *
 * The contract this locks down: the header is either honoured or refused,
 * never silently ignored on a mutating endpoint. The drift guard that keeps
 * the supported set from rotting lives in `idempotency-contract.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { apiKeys, endUsers } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { assertDbCount } from "../../helpers/assertions.ts";

const app = getTestApp();

describe("Idempotency-Key guard", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "idemguard" });
  });

  function jsonHeaders(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...authHeaders(ctx),
      "Content-Type": "application/json",
    };
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
    return headers;
  }

  // POST /api/api-keys is a mutating endpoint with no `idempotency()` mount —
  // the representative "unsupported" route, chosen because its side effect is
  // a single row we can assert on.
  function postApiKey(name: string, idempotencyKey?: string) {
    return app.request("/api/api-keys", {
      method: "POST",
      headers: jsonHeaders(idempotencyKey),
      body: JSON.stringify({ name }),
    });
  }

  describe("supported routes still honour the key", () => {
    it("replays the cached response on POST /api/end-users", async () => {
      const body = JSON.stringify({ name: "Alice" });

      const first = await app.request("/api/end-users", {
        method: "POST",
        headers: jsonHeaders("guard-supported-1"),
        body,
      });
      expect(first.status).toBe(201);
      expect(first.headers.get("Idempotent-Replayed")).toBeNull();

      const replay = await app.request("/api/end-users", {
        method: "POST",
        headers: jsonHeaders("guard-supported-1"),
        body,
      });
      expect(replay.status).toBe(201);
      expect(replay.headers.get("Idempotent-Replayed")).toBe("true");

      await assertDbCount(endUsers, eq(endUsers.orgId, ctx.orgId), 1);
    });
  });

  describe("unsupported mutating routes refuse the key", () => {
    it("returns 400 naming the header and performs no side effect", async () => {
      const res = await postApiKey("Refused Key", "guard-unsupported-1");

      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/problem+json");

      const problem = (await res.json()) as { code: string; param?: string; detail: string };
      expect(problem.code).toBe("idempotency_not_supported");
      expect(problem.param).toBe("Idempotency-Key");
      expect(problem.detail).toContain("Idempotency-Key");

      // The point of rejecting *before* the handler: the key was never created.
      await assertDbCount(apiKeys, eq(apiKeys.orgId, ctx.orgId), 0);
    });

    it("still works normally without the header (regression)", async () => {
      const res = await postApiKey("Allowed Key");
      expect(res.status).toBe(201);
      await assertDbCount(apiKeys, eq(apiKeys.orgId, ctx.orgId), 1);
    });

    it("refuses on non-POST unsafe methods too", async () => {
      const created = await postApiKey("Doomed Key");
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      const res = await app.request(`/api/api-keys/${id}`, {
        method: "DELETE",
        headers: jsonHeaders("guard-unsupported-delete"),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("idempotency_not_supported");

      // DELETE is idempotent per RFC 9110, but we do not replay its response —
      // so we refuse the header rather than imply we do. Row still present.
      await assertDbCount(apiKeys, eq(apiKeys.id, id), 1);
    });
  });

  describe("safe methods ignore the key", () => {
    it("does not reject a GET carrying Idempotency-Key", async () => {
      const res = await app.request("/api/api-keys", {
        method: "GET",
        headers: jsonHeaders("guard-safe-1"),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("unknown endpoints still 404", () => {
    it("prefers not-found over a header complaint", async () => {
      const res = await app.request("/api/definitely-not-a-route", {
        method: "POST",
        headers: jsonHeaders("guard-404"),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });
});
