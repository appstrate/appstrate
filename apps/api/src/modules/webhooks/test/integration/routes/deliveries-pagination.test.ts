// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/webhooks/{id}/deliveries` pages through the WHOLE history: an
 * honest `hasMore`, a `startingAfter` keyset and an RFC 5988 `Link` header.
 * It used to return the newest page with `hasMore: false` unconditionally.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { webhookDeliveries } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { walkLinkPages } from "../../../../../../test/helpers/pagination.ts";

const app = getTestApp();

interface DeliveryPage {
  data: { id: string; eventId: string }[];
  hasMore: boolean;
}

describe("GET /api/webhooks/:id/deliveries pagination", () => {
  let ctx: TestContext;
  let webhookId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
    const res = await app.request("/api/webhooks", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "space",
        spaceId: ctx.defaultSpaceId,
        url: "https://example.com/webhook",
        events: ["run.success"],
      }),
    });
    webhookId = ((await res.json()) as { id: string }).id;
  });

  /** `count` deliveries; pairs share a timestamp so the `id` tiebreak is exercised. */
  async function seedDeliveries(count: number): Promise<void> {
    const base = Date.parse("2026-09-01T00:00:00.000Z");
    await db.insert(webhookDeliveries).values(
      Array.from({ length: count }, (_, i) => ({
        webhookId,
        eventId: `evt_${String(i).padStart(3, "0")}`,
        eventType: "run.success",
        status: "success" as const,
        attempt: 1,
        createdAt: new Date(base + Math.floor(i / 2) * 1000),
      })),
    );
  }

  function list(query = "") {
    return app.request(`/api/webhooks/${webhookId}/deliveries${query}`, {
      headers: authHeaders(ctx),
    });
  }

  it("walks every delivery exactly once by following the Link header", async () => {
    await seedDeliveries(7);
    const pages = await walkLinkPages<DeliveryPage>(
      app,
      `/api/webhooks/${webhookId}/deliveries?limit=3`,
      authHeaders(ctx),
    );
    // A Link was followed after every page but the last.
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
    const seen = pages.flatMap((p) => p.data.map((d) => d.eventId));
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    // Newest first.
    expect(seen[0] === "evt_006" || seen[0] === "evt_005").toBe(true);
    expect(seen.slice(-1)[0] === "evt_000" || seen.slice(-1)[0] === "evt_001").toBe(true);
  });

  it("reports hasMore false and no Link on the last page", async () => {
    await seedDeliveries(2);
    const res = await list("?limit=2");
    const body = (await res.json()) as DeliveryPage;
    expect(body.data).toHaveLength(2);
    expect(body.hasMore).toBe(false);
    expect(res.headers.get("Link")).toBeNull();
  });

  it("caps the page at 100", async () => {
    await seedDeliveries(101);
    const res = await list("?limit=500");
    const body = (await res.json()) as DeliveryPage;
    // Out-of-range falls back to the default of 20 (parseListPagination idiom).
    expect(body.data).toHaveLength(20);
    const max = (await (await list("?limit=100")).json()) as DeliveryPage;
    expect(max.data).toHaveLength(100);
    expect(max.hasMore).toBe(true);
  });

  it("rejects a cursor that is not a delivery of this webhook", async () => {
    await seedDeliveries(1);
    for (const cursor of ["not-a-uuid", crypto.randomUUID()]) {
      const res = await list(`?startingAfter=${cursor}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { param?: string }).param).toBe("startingAfter");
    }
  });
});
