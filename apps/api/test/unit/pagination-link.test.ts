// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { Hono } from "hono";
import { setOffsetLinkHeader } from "../../src/lib/pagination-link.ts";

// Cursor and `since` links are covered in packages/core/test/pagination-link.test.ts.
describe("public pagination links behind a reverse proxy", () => {
  let savedAppUrl: string | undefined;

  beforeEach(() => {
    savedAppUrl = process.env.APP_URL;
    process.env.APP_URL = "https://app.example.test";
    _resetCacheForTesting();
  });

  afterEach(() => {
    if (savedAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = savedAppUrl;
    _resetCacheForTesting();
  });

  it("emits offset links on the browser-facing origin", async () => {
    const app = new Hono();
    app.get("/items", (c) => {
      setOffsetLinkHeader({ c, limit: 10, offset: 10, total: 50 });
      return c.json({ data: [] });
    });

    const response = await app.request("http://api:3000/items?limit=10&offset=10");

    expect(response.headers.get("Link")).toContain(
      '<https://app.example.test/items?limit=10&offset=20>; rel="next"',
    );
  });
});
