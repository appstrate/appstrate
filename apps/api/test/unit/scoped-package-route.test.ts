// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { SCOPED_PACKAGE_ROUTE } from "../../src/routes/scoped-package-route.ts";

function buildApp(): Hono {
  const app = new Hono();
  app.get(`/${SCOPED_PACKAGE_ROUTE}`, (c) =>
    c.json({ scope: c.req.param("scope"), name: c.req.param("name") }),
  );
  return app;
}

describe("SCOPED_PACKAGE_ROUTE", () => {
  it("matches a literal @ scope", async () => {
    const res = await buildApp().request("/@acme/my-agent");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ scope: "@acme", name: "my-agent" });
  });

  it("matches an encoded @ scope", async () => {
    const res = await buildApp().request("/%40acme/my-agent");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ scope: "@acme", name: "my-agent" });
  });

  it("does not accept encoded slashes as package separators", async () => {
    const res = await buildApp().request("/%40acme%2Fmy-agent");

    expect(res.status).toBe(404);
  });

  it("keeps the route constrained to package slugs", async () => {
    const res = await buildApp().request("/%40Acme/my-agent");

    expect(res.status).toBe(404);
  });

  it("rejects slugs with trailing hyphens", async () => {
    const res = await buildApp().request("/%40acme-/my-agent");

    expect(res.status).toBe(404);
  });
});
