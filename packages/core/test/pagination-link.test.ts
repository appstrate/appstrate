// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { Hono, type Handler } from "hono";
import { setCursorLinkHeader, setSinceLinkHeader } from "../src/pagination-link.ts";

const ORIGIN = "https://app.example.com";

async function linkFor(path: string, set: Handler): Promise<string | null> {
  const app = new Hono();
  app.get("/list", set);
  const res = await app.request(`http://10.0.0.1:3000${path}`);
  return res.headers.get("Link");
}

describe("pagination links", () => {
  it("roots next/prev cursor links on the public origin, replacing stale cursors", async () => {
    const link = await linkFor("/list?limit=2&endingBefore=x", (c) => {
      setCursorLinkHeader({
        c,
        publicOrigin: ORIGIN,
        hasMore: true,
        lastId: "b",
        firstId: "a",
        hasPrev: true,
      });
      return c.body(null, 204);
    });
    expect(link).toBe(
      `<${ORIGIN}/list?limit=2&startingAfter=b>; rel="next", <${ORIGIN}/list?limit=2&endingBefore=a>; rel="prev"`,
    );
  });

  it("emits a since link carrying the caller's other params", async () => {
    const link = await linkFor("/list?level=info&since=3", (c) => {
      setSinceLinkHeader({ c, publicOrigin: ORIGIN, hasMore: true, lastId: 9 });
      return c.body(null, 204);
    });
    expect(link).toBe(`<${ORIGIN}/list?level=info&since=9>; rel="next"`);
  });

  it("sets no header when no page follows", async () => {
    const link = await linkFor("/list", (c) => {
      setCursorLinkHeader({ c, publicOrigin: ORIGIN, hasMore: false, lastId: "b" });
      setSinceLinkHeader({ c, publicOrigin: ORIGIN, hasMore: false, lastId: 9 });
      return c.body(null, 204);
    });
    expect(link).toBeNull();
  });
});
