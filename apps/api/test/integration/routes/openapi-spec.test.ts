// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/openapi.json` — caching contract.
 *
 * The endpoint is public, pre-auth and un-rate-limited, so the ~470 KiB
 * file must be serialized once and revalidatable. `apps/cli` already
 * sends `If-None-Match` and handles 304; these tests lock the server side of
 * that exchange, plus the fact that the spec is not re-serialized per hit.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createOpenApiSpecRouter } from "../../../src/routes/openapi-spec.ts";

const spec = { openapi: "3.1.0", info: { title: "Appstrate API", version: "2026-03-21" } };

function makeApp() {
  let builds = 0;
  const app = new Hono();
  app.route(
    "/",
    createOpenApiSpecRouter(() => {
      builds += 1;
      return spec;
    }),
  );
  return { app, buildCount: () => builds };
}

describe("GET /api/openapi.json", () => {
  it("serves the spec with a strong ETag", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(await res.json()).toEqual(spec);
  });

  it("returns 304 with an empty body when If-None-Match matches", async () => {
    const { app } = makeApp();
    const first = await app.request("/api/openapi.json");
    const etag = first.headers.get("ETag")!;

    const res = await app.request("/api/openapi.json", { headers: { "If-None-Match": etag } });

    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  it("returns 200 when If-None-Match carries a stale tag", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/openapi.json", {
      headers: { "If-None-Match": '"0000000000000000000000000000dead"' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(spec);
  });

  it("honours a weak tag and a multi-value If-None-Match list", async () => {
    const { app } = makeApp();
    const etag = (await app.request("/api/openapi.json")).headers.get("ETag")!;

    const weak = await app.request("/api/openapi.json", {
      headers: { "If-None-Match": `W/${etag}` },
    });
    expect(weak.status).toBe(304);

    const list = await app.request("/api/openapi.json", {
      headers: { "If-None-Match": `"stale", ${etag}` },
    });
    expect(list.status).toBe(304);

    const wildcard = await app.request("/api/openapi.json", { headers: { "If-None-Match": "*" } });
    expect(wildcard.status).toBe(304);
  });

  it("is a stable ETag and builds the spec only once across requests", async () => {
    const { app, buildCount } = makeApp();

    const a = await app.request("/api/openapi.json");
    const b = await app.request("/api/openapi.json");

    expect(a.headers.get("ETag")).toBe(b.headers.get("ETag"));
    expect(buildCount()).toBe(1);
  });
});
