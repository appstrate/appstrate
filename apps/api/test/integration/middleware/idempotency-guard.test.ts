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
import { Hono } from "hono";
import { apiKeys, endUsers } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { errorHandler } from "../../../src/middleware/error-handler.ts";
import { idempotency, isIdempotencyAware } from "../../../src/middleware/idempotency.ts";
import { idempotencyGuard } from "../../../src/middleware/idempotency-guard.ts";
import type { AppEnv } from "../../../src/types/index.ts";

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

/**
 * Regression: the marker must survive `app.route()`.
 *
 * hono 4.12 `hono-base.js` `route()` re-wraps every handler of the mounted
 * sub-app whenever that sub-app installed its own `onError()`, stashing the
 * original under the `COMPOSED_HANDLER` property. A property read on the
 * wrapper therefore sees nothing, and the guard used to 400 a header the route
 * genuinely honoured. No production sub-router calls `.onError()` today, which
 * is why this only ever failed here — a latent trap for the first one that
 * does. `isIdempotencyAware` now unwraps via Hono's own `findTargetHandler`.
 */
describe("Idempotency-Key marker survives route() composition", () => {
  // The idempotency cache is Redis-backed with a 24h TTL and is keyed by org —
  // it outlives `truncateAll()` and the test process. A fixed org id would make
  // the second local run of this file replay the first run's cached response.
  const ORG_ID = `org_idem_composed_${crypto.randomUUID()}`;

  /** Minimal app: guard → `app.route()` of a sub-router mounting `idempotency()`. */
  function buildComposedApp(subAppHasOwnErrorHandler: boolean) {
    const sub = new Hono<AppEnv>();
    // The trigger: a sub-app-local error handler makes `route()` wrap.
    if (subAppHasOwnErrorHandler) sub.onError((_err, c) => c.json({ from: "sub" }, 500));
    sub.post("/composed", idempotency(), (c) => c.json({ ok: true }, 201));

    const parent = new Hono<AppEnv>();
    parent.onError(errorHandler);
    // `idempotency()` scopes its cache key to the org; give it one.
    parent.use("*", async (c, next) => {
      c.set("orgId", ORG_ID);
      return next();
    });
    parent.use("*", idempotencyGuard());
    parent.route("/api", sub);
    return parent;
  }

  function post(target: Hono<AppEnv>, key: string) {
    return target.request("/api/composed", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ hello: "world" }),
    });
  }

  it("reads the marker through the wrapper `route()` installs", () => {
    const aware = buildComposedApp(true).routes.filter((r) => isIdempotencyAware(r.handler));
    expect(aware.map((r) => `${r.method.toLowerCase()} ${r.path}`)).toEqual(["post /api/composed"]);

    // The unwrap is load-bearing, not decoration: the *registered* handler is
    // Hono's wrapper and carries no marker of its own. Reading the property
    // directly — what `isIdempotencyAware` used to do — sees nothing.
    const registered = aware[0]!.handler as unknown as Record<symbol, unknown>;
    expect(registered[Symbol.for("appstrate.idempotencyAware")]).toBeUndefined();
  });

  it("honours the header on a sub-router that has its own onError()", async () => {
    const composed = buildComposedApp(true);

    const first = await post(composed, "composed-onerror-1");
    expect(first.status).toBe(201);
    expect(first.headers.get("Idempotent-Replayed")).toBeNull();

    const replay = await post(composed, "composed-onerror-1");
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
  });

  it("behaves identically without the sub-router onError() (control)", async () => {
    const plain = buildComposedApp(false);

    const first = await post(plain, "composed-plain-1");
    expect(first.status).toBe(201);

    const replay = await post(plain, "composed-plain-1");
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
  });
});
