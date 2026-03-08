import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { isOwnedByOrg } from "@appstrate/core/naming";

/**
 * Tests for the requireOwnedPackage middleware pattern.
 *
 * We replicate the middleware logic inline instead of importing from guards.ts
 * to avoid mock.module contamination across test files (bun:test runs all files
 * in the same process).
 */

function requireOwnedPackageInline() {
  return async (
    c: {
      req: { param: (k: string) => string | undefined };
      get: (k: string) => string;
      json: (body: unknown, status: number) => Response;
    },
    next: () => Promise<void>,
  ) => {
    const scope = c.req.param("scope");
    const name = c.req.param("name");
    const id = c.req.param("id");
    const packageId = scope && name ? `${scope}/${name}` : id;
    if (!packageId) return next();

    const orgSlug = c.get("orgSlug");
    if (!isOwnedByOrg(packageId, orgSlug)) {
      return c.json(
        {
          error: "NOT_OWNED",
          message: "Cannot modify a package not owned by your organization. Fork it instead.",
        },
        403,
      );
    }
    return next();
  };
}

function createApp(orgSlug: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("orgId" as never, "org-1" as never);
    c.set("orgSlug" as never, orgSlug as never);
    c.set("orgRole" as never, "admin" as never);
    await next();
  });

  // Scoped mutation routes (guarded)
  app.put("/packages/:scope{@[^/]+}/:name", requireOwnedPackageInline() as never, (c) =>
    c.json({ ok: true }),
  );
  app.delete("/packages/:scope{@[^/]+}/:name", requireOwnedPackageInline() as never, (c) =>
    c.json({ ok: true }),
  );
  app.post("/packages/:scope{@[^/]+}/:name/versions", requireOwnedPackageInline() as never, (c) =>
    c.json({ ok: true }),
  );

  // Config route — NOT guarded
  app.put("/flows/:scope{@[^/]+}/:name/config", (c) => c.json({ ok: true }));

  // GET route — NOT guarded
  app.get("/packages/:scope{@[^/]+}/:name", (c) => c.json({ ok: true }));

  return app;
}

describe("requireOwnedPackage middleware", () => {
  test("PUT non-owned scoped package → 403 NOT_OWNED", async () => {
    const app = createApp("acme");
    const res = await app.request("/packages/@other/my-flow", { method: "PUT" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_OWNED");
  });

  test("DELETE non-owned scoped package → 403 NOT_OWNED", async () => {
    const app = createApp("acme");
    const res = await app.request("/packages/@other/my-flow", { method: "DELETE" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_OWNED");
  });

  test("POST version on non-owned → 403 NOT_OWNED", async () => {
    const app = createApp("acme");
    const res = await app.request("/packages/@other/my-flow/versions", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_OWNED");
  });

  test("PUT owned scoped package → passes through (200)", async () => {
    const app = createApp("acme");
    const res = await app.request("/packages/@acme/my-flow", { method: "PUT" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("PUT config on non-owned → allowed (no guard)", async () => {
    const app = createApp("acme");
    const res = await app.request("/flows/@other/my-flow/config", { method: "PUT" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("GET non-owned → allowed (no guard)", async () => {
    const app = createApp("acme");
    const res = await app.request("/packages/@other/my-flow", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
