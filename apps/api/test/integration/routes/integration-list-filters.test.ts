// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/integrations?q=…&id=…` (#1991): the two filters narrow the placed
 * set, never widen it. Each narrowing is checked against the unfiltered list it
 * comes from, and the placement rule still applies under them: an id the space
 * cannot read is absent, as it is from the plain list.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedUnreachableSpace } from "../../helpers/seed.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const GMAIL = "@filters/gmail";
const SLACK = "@filters/slack";
const NOTION = "@filters/notion";
/** Homed in a stranger's personal space: never listed here, filtered or not. */
const PRIVATE = "@filters/private";

let ctx: TestContext;

function manifestFor(id: string, displayName: string, description: string) {
  return localIntegrationManifest({
    name: id,
    displayName,
    description,
    auths: {
      api: {
        type: "api_key",
        authorizedUris: ["https://example.test/**"],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "api_key",
        }),
      },
    },
  }) as unknown as Record<string, unknown>;
}

async function list(query: string) {
  const res = await app.request(`/api/integrations${query}`, { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { id: string }[];
    total: number;
    hasMore: boolean;
  };
  return { ids: body.data.map((row) => row.id), total: body.total, hasMore: body.hasMore };
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  const seed = (id: string, displayName: string, description: string, homeSpaceId: string) =>
    seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      homeSpaceId,
      draftManifest: manifestFor(id, displayName, description),
    });
  await seed(GMAIL, "Gmail", "Read and send mail", ctx.defaultSpaceId);
  await seed(SLACK, "Slack", "Post to channels (100% chat)", ctx.defaultSpaceId);
  await seed(NOTION, "Notion", "Pages and databases", ctx.defaultSpaceId);
  const personal = await seedUnreachableSpace(ctx.orgId, "Stranger");
  await seed(PRIVATE, "Gmail private", "Mail nobody offered", personal);
});

describe("GET /api/integrations — id filter", () => {
  it("returns exactly the named integrations", async () => {
    const { ids, total } = await list(`?id=${SLACK},${GMAIL}`);
    expect(ids).toEqual([GMAIL, SLACK]);
    expect(total).toBe(2);
  });

  it("drops an id the space cannot read, as the plain list does", async () => {
    expect((await list("")).ids).not.toContain(PRIVATE);
    expect((await list(`?id=${PRIVATE},${NOTION}`)).ids).toEqual([NOTION]);
  });

  it("an empty value is no filter", async () => {
    expect((await list("?id=")).ids).toEqual((await list("")).ids);
  });

  it("paginates the filtered set", async () => {
    const first = await list(`?id=${GMAIL},${SLACK},${NOTION}&limit=2`);
    expect(first).toEqual({ ids: [GMAIL, NOTION], total: 3, hasMore: true });
  });

  it("refuses more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `@filters/x${i}`).join(",");
    const res = await app.request(`/api/integrations?id=${ids}`, { headers: authHeaders(ctx) });
    await expectProblem(res, 400);
  });
});

describe("GET /api/integrations — q filter", () => {
  it("matches the display name, case-insensitively", async () => {
    expect((await list("?q=gMaIl")).ids).toEqual([GMAIL]);
  });

  it("matches the description and the package id", async () => {
    expect((await list("?q=databases")).ids).toEqual([NOTION]);
    expect((await list("?q=filters/sla")).ids).toEqual([SLACK]);
  });

  it("takes `%` as typed", async () => {
    expect((await list("?q=100%25")).ids).toEqual([SLACK]);
    expect((await list("?q=%25%25")).ids).toEqual([]);
  });

  it("combines with id", async () => {
    expect((await list(`?q=mail&id=${SLACK},${NOTION}`)).ids).toEqual([]);
    expect((await list(`?q=mail&id=${GMAIL},${NOTION}`)).ids).toEqual([GMAIL]);
  });

  it("refuses a query longer than 200 characters", async () => {
    const res = await app.request(`/api/integrations?q=${"a".repeat(201)}`, {
      headers: authHeaders(ctx),
    });
    await expectProblem(res, 400);
  });
});
