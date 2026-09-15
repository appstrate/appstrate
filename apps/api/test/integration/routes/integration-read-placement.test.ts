// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/integrations` and `GET /api/integrations/{packageId}` obey
 * PLACEMENT — the same rule every other package read obeys.
 *
 * These two routes are the Integrations page's own surface, and they used to
 * ask a question no other read asks: "does this organization own the row?",
 * with no placement conjunct at all. An integration homed in somebody's
 * PERSONAL space and offered to nobody therefore came back in full — name,
 * description, `auths` with their `authorized_uris`, tool catalog — to any
 * caller holding `integrations:read`, organization owners included. RBAC spec
 * §3.6 says the opposite in as many words: owners and admins neither read nor
 * write a personal space, and the home is the only authority there is.
 *
 * So the contract asserted here is a CONTRAST, not a single verdict. For the
 * very same row and the very same caller, `GET /api/packages/integrations` and
 * `GET /api/packages/integrations/{id}` already answered "absent" and "404";
 * this suite pins the two `/api/integrations` routes to those answers, and
 * pins the two placements that DO grant the read — homed here, offered here —
 * so the fix cannot be mistaken for "the page shows less now".
 *
 * Placement is not activation: an offer the space has not taken up is listed,
 * with `active: false`. That is the whole point of the Integrations page
 * carrying the flag rather than the filter.
 *
 * NEGATIVE CONTROL for the whole file: make `placementReadFilter`
 * (`services/package-placement.ts`) return `sql\`true\`` unconditionally.
 * Every `it` that asserts absence or 404 goes red, which is what proves they
 * read the placement conjunct and not some other refusal (the org boundary,
 * the type filter, a missing permission).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedPackage,
  seedPackageShare,
  seedSpace,
  seedUnreachableSpace,
} from "../../helpers/seed.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

/** Homed in a stranger's personal space, offered to nobody. */
const PRIVATE = "@probe/private-integration";
/** Homed in another TEAM space of the org, offered to the caller's space. */
const OFFERED = "@probe/offered-integration";
/** Homed in the caller's own space. */
const HOMED = "@probe/homed-integration";

/**
 * The string that must never come back: it lives only on the private draft's
 * manifest. An id check alone would miss the actual disclosure — the manifest
 * travels whole on both routes.
 */
const SECRET = "the private draft nobody offered";

let ctx: TestContext;
let member: TestContext;

function manifestFor(id: string, description?: string) {
  return localIntegrationManifest({
    name: id,
    displayName: id,
    ...(description !== undefined ? { description } : {}),
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

async function listIds(as: TestContext): Promise<string[]> {
  const res = await app.request("/api/integrations", { headers: authHeaders(as) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((r) => r.id);
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  // An ordinary member of the same org, reading from the same default space:
  // the owner is not a special case of this rule, and neither is the member.
  member = await memberContext(ctx, "member", "builder");

  const personal = await seedUnreachableSpace(ctx.orgId, "Stranger");
  await seedPackage({
    id: PRIVATE,
    orgId: ctx.orgId,
    type: "integration",
    homeSpaceId: personal,
    draftManifest: manifestFor(PRIVATE, SECRET),
  });

  const otherTeam = await seedSpace({ orgId: ctx.orgId, name: "Other team" });
  await seedPackage({
    id: OFFERED,
    orgId: ctx.orgId,
    type: "integration",
    homeSpaceId: otherTeam.id,
    draftManifest: manifestFor(OFFERED),
  });
  // Offered, NOT taken up: no `space_packages` row anywhere.
  await seedPackageShare(ctx.defaultSpaceId, OFFERED);

  await seedPackage({
    id: HOMED,
    orgId: ctx.orgId,
    type: "integration",
    homeSpaceId: ctx.defaultSpaceId,
    draftManifest: manifestFor(HOMED),
  });
});

describe("GET /api/integrations — the index", () => {
  it("lists what is placed here and omits the personal-space draft, for an owner", async () => {
    const ids = await listIds(ctx);
    expect(ids).toContain(HOMED);
    expect(ids).toContain(OFFERED);
    expect(ids).not.toContain(PRIVATE);
  });

  it("answers the same to an ordinary member", async () => {
    const ids = await listIds(member);
    expect(ids).toContain(HOMED);
    expect(ids).toContain(OFFERED);
    expect(ids).not.toContain(PRIVATE);
  });

  it("does not name the private draft anywhere in the payload", async () => {
    const res = await app.request("/api/integrations", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    // The rows carry the whole manifest, so the description leaks with them.
    expect(await res.text()).not.toContain(SECRET);
  });

  it("agrees with `GET /api/packages/integrations`, which already refused it", async () => {
    const res = await app.request("/api/packages/integrations", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const indexIds = body.data.map((r) => r.id).sort();
    // Not identical sets — the package index renders the ACTIVE set, and the
    // pending offer is placed but not active. What must agree is the refusal.
    expect(indexIds).not.toContain(PRIVATE);
    expect(await listIds(ctx)).not.toContain(PRIVATE);
  });

  it("carries the pending offer with `active: false` — placement, not activation", async () => {
    const res = await app.request("/api/integrations", { headers: authHeaders(ctx) });
    const body = (await res.json()) as { data: { id: string; active: boolean }[] };
    const offered = body.data.find((r) => r.id === OFFERED);
    expect(offered).toBeDefined();
    expect(offered!.active).toBe(false);
  });
});

describe("GET /api/integrations/{packageId} — the detail", () => {
  async function detail(as: TestContext, id: string) {
    // NOT url-encoded: the route pattern is `/:packageId{@[^/]+/[^/]+}`, and an
    // encoded `@scope%2Fname` misses it — a 404 from the router, which would
    // make every refusal below pass for the wrong reason.
    return app.request(`/api/integrations/${id}`, { headers: authHeaders(as) });
  }

  it("404s on the personal-space draft, for an owner", async () => {
    const res = await detail(ctx, PRIVATE);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("404s on the personal-space draft, for an ordinary member", async () => {
    const res = await detail(member, PRIVATE);
    expect(res.status).toBe(404);
  });

  it("200s on a package homed here", async () => {
    const res = await detail(ctx, HOMED);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manifest: { name: string }; active: boolean };
    expect(body.manifest.name).toBe(HOMED);
  });

  it("200s on a package merely OFFERED here, and says it is not active", async () => {
    const res = await detail(ctx, OFFERED);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });

  it("agrees with `GET /api/packages/integrations/{id}`, which already 404ed", async () => {
    const pkg = await app.request(`/api/packages/integrations/${PRIVATE}`, {
      headers: authHeaders(ctx),
    });
    expect(pkg.status).toBe(404);
    expect((await detail(ctx, PRIVATE)).status).toBe(404);
  });
});
