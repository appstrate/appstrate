// SPDX-License-Identifier: Apache-2.0

/**
 * A space with more integrations than `GET /api/integrations` returns per page
 * (100) — issue #1871 §1. The detail page read `active` from that list's FIRST
 * page, so an integration sorted past row 100 read "not active" forever and
 * "Activer" looked like a no-op. The detail answers for the integration itself,
 * and the list pages through a stable order.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const COUNT = 105;
/** Zero-padded so every collation sorts them the same way. */
const OURS = Array.from({ length: COUNT }, (_, i) => `@bulk/int-${String(i).padStart(3, "0")}`);

let ctx: TestContext;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  // Seeded in reverse, so insertion order cannot pass for the sort.
  for (const id of [...OURS].reverse()) {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: localIntegrationManifest({
        name: id,
        displayName: id,
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://example.test/**"],
            delivery: httpHeaderDelivery({ name: "Authorization", field: "api_key" }),
          },
        },
      }) as unknown as Record<string, unknown>,
    });
  }
});

type ListBody = { data: { id: string; active: boolean }[]; total: number; hasMore: boolean };

async function listPage(offset: number): Promise<ListBody> {
  const res = await app.request(`/api/integrations?fields=id,active&offset=${offset}`, {
    headers: authHeaders(ctx),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

async function listAll(): Promise<{ id: string; active: boolean }[]> {
  const rows: { id: string; active: boolean }[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await listPage(offset);
    rows.push(...page.data);
    if (!page.hasMore) return rows;
  }
}

async function detailActive(id: string): Promise<boolean> {
  // Not url-encoded: the route pattern is `/:packageId{@[^/]+/[^/]+}`.
  const res = await app.request(`/api/integrations/${id}`, { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { active: boolean }).active;
}

describe("more integrations than one page of GET /api/integrations", () => {
  it("pages through a stable order, sorted by id, every row exactly once", async () => {
    const first = await listPage(0);
    expect(first.data).toHaveLength(100);
    expect(first.hasMore).toBe(true);

    const all = await listAll();
    const ids = all.map((r) => r.id);
    expect(ids).toHaveLength(first.total);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => OURS.includes(id))).toEqual(OURS);
    // A second read answers the same sequence.
    expect((await listAll()).map((r) => r.id)).toEqual(ids);
  });

  it("reports and activates an integration sorted past row 100 through its own detail", async () => {
    const firstPage = new Set((await listPage(0)).data.map((r) => r.id));
    const target = OURS.findLast((id) => !firstPage.has(id));
    if (!target) throw new Error("every seeded integration fit on the first page");

    expect(await detailActive(target)).toBe(false);

    // The door the SPA's "Activer" uses.
    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ packageId: target }),
    });
    expect(res.status).toBe(201);

    expect(await detailActive(target)).toBe(true);
    expect((await listAll()).find((r) => r.id === target)?.active).toBe(true);
  });
});
