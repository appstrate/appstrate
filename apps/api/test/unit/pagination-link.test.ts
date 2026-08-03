// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { Hono } from "hono";
import {
  setCursorLinkHeader,
  setOffsetLinkHeader,
  setSinceLinkHeader,
} from "../../src/lib/pagination-link.ts";

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

  it("emits cursor links on the browser-facing origin", async () => {
    const app = new Hono();
    app.get("/items", (c) => {
      setCursorLinkHeader({ c, hasMore: true, lastId: "item 20" });
      return c.json({ data: [] });
    });

    const response = await app.request("http://api:3000/items?limit=10");

    expect(response.headers.get("Link")).toBe(
      '<https://app.example.test/items?limit=10&startingAfter=item+20>; rel="next"',
    );
  });

  it("emits monotonic-cursor links on the browser-facing origin", async () => {
    const app = new Hono();
    app.get("/runs/run-1/logs", (c) => {
      setSinceLinkHeader({ c, hasMore: true, lastId: 42 });
      return c.json({ data: [] });
    });

    const response = await app.request("http://api:3000/runs/run-1/logs?level=info&limit=10");

    expect(response.headers.get("Link")).toBe(
      '<https://app.example.test/runs/run-1/logs?level=info&limit=10&since=42>; rel="next"',
    );
  });
});
