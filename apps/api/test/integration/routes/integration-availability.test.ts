// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/integrations/{packageId}` carries `availability`: the library's
 * answer for (this package, the current space), projected — never recomputed.
 *
 * Every case asserts the same two things beside its own expectation: the
 * object equals the matching cell of `GET /api/spaces/{id}/library` for the
 * same caller (the "no second calculation" proof), and the detail's `active`
 * agrees with `availability.state`.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberHolding,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedOrgOffer, seedPackage, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const HOMED = "@probe/homed-integration";
const SHARED = "@probe/shared-integration";
const OFFERED = "@probe/offered-integration";

let ctx: TestContext;
let otherTeam: string;

function manifestFor(id: string) {
  return localIntegrationManifest({
    name: id,
    displayName: id,
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

interface Availability {
  via: string;
  state: string;
  shared_by: { user_id: string; name: string } | null;
  offered_to_org: boolean;
  org_offerable: boolean;
  activate: string;
  deactivate: string;
}

/** The detail's `availability` and `active`, plus the library's cell for the same caller. */
async function read(as: TestContext, id: string) {
  const res = await app.request(`/api/integrations/${id}`, { headers: authHeaders(as) });
  expect(res.status, await res.clone().text()).toBe(200);
  const detail = (await res.json()) as { active: boolean; availability: Availability };

  const lib = await app.request(`/api/spaces/${as.defaultSpaceId}/library`, {
    headers: authHeaders(as),
  });
  expect(lib.status, await lib.clone().text()).toBe(200);
  const library = (await lib.json()) as {
    packages: {
      integration: {
        id: string;
        offered_to_org: boolean;
        org_offerable: boolean;
        placements: {
          space_id: string;
          via: string;
          state: string;
          shared_by: Availability["shared_by"];
        }[];
        activation: { spaceId: string; activate: string; deactivate: string }[];
      }[];
    };
  };
  const entry = library.packages.integration.find((p) => p.id === id)!;
  const placement = entry.placements.find((p) => p.space_id === as.defaultSpaceId)!;
  const cell = entry.activation.find((a) => a.spaceId === as.defaultSpaceId)!;
  const fromLibrary = {
    via: placement.via,
    state: placement.state,
    shared_by: placement.shared_by,
    offered_to_org: entry.offered_to_org,
    org_offerable: entry.org_offerable,
    activate: cell.activate,
    deactivate: cell.deactivate,
  };

  expect(detail.availability).toEqual(fromLibrary);
  expect(detail.active).toBe(detail.availability.state === "active");
  return detail.availability;
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  otherTeam = (await seedSpace({ orgId: ctx.orgId, name: "Other team" })).id;
  for (const [id, home] of [
    [HOMED, ctx.defaultSpaceId],
    [SHARED, otherTeam],
    [OFFERED, otherTeam],
  ] as const) {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      homeSpaceId: home,
      draftManifest: manifestFor(id),
    });
  }
});

describe("GET /api/integrations/{packageId} — availability", () => {
  it("reads `home` for an integration homed in the space", async () => {
    const a = await read(ctx, HOMED);
    expect(a).toMatchObject({ via: "home", shared_by: null, offered_to_org: false });
  });

  it("reads `shared`, with who shared it, for an integration homed elsewhere", async () => {
    await seedSpacePackage(ctx.defaultSpaceId, SHARED, {
      enabled: true,
      sharedBy: ctx.user.id,
    });
    const a = await read(ctx, SHARED);
    expect(a).toMatchObject({ via: "shared", state: "active" });
    expect(a.shared_by?.user_id).toBe(ctx.user.id);
  });

  it("reads `organization` and `active` for an offer with no row of the space's own", async () => {
    await seedOrgOffer(ctx.orgId, OFFERED);
    const a = await read(ctx, OFFERED);
    expect(a).toMatchObject({ via: "organization", state: "active", offered_to_org: true });
  });

  it("reads `inactive` once the space has switched the integration off", async () => {
    await seedSpacePackage(ctx.defaultSpaceId, HOMED, { enabled: false });
    const a = await read(ctx, HOMED);
    expect(a).toMatchObject({ via: "home", state: "inactive" });
  });

  it("gives an owner the offer and activation verdicts", async () => {
    // An offer already stands, so withdrawing it needs no published version.
    await seedOrgOffer(ctx.orgId, OFFERED);
    const a = await read(ctx, OFFERED);
    expect(a).toMatchObject({ org_offerable: true, activate: "allowed", deactivate: "allowed" });
  });

  it("refuses a caller holding only the read grants, everywhere the role lacks the grant", async () => {
    const reader = await memberHolding(ctx, ["integrations:read", "spaces:read"]);
    const a = await read(reader, HOMED);
    expect(a).toMatchObject({
      org_offerable: false,
      activate: "forbidden",
      deactivate: "forbidden",
    });
  });
});
