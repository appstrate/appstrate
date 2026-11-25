// SPDX-License-Identifier: Apache-2.0

/**
 * The agent and skill details carry `availability` like the integration
 * detail does (`integration-availability.test.ts`): the library's answer for
 * (this package, the current space), projected — never recomputed.
 *
 * Every case asserts, beside its own expectation, that the object equals the
 * matching cell of `GET /api/spaces/{id}/library` for the same caller, and
 * that it agrees with the space's switch (`active` on an agent).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { PackageType } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberHolding,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedOrgOffer,
  seedPackage,
  seedPublishedVersion,
  seedSpace,
  seedSpacePackage,
} from "../../helpers/seed.ts";

const app = getTestApp();

interface Availability {
  via: string;
  state: string;
  shared_by: { user_id: string; name: string } | null;
  offered_to_org: boolean;
  org_offerable: boolean;
  active_by_default: boolean;
}

type Kind = Extract<PackageType, "agent" | "skill">;
const SEGMENT = { agent: "agents", skill: "skills" } as const;

const ids = (type: Kind) => ({
  homed: `@probe/homed-${type}`,
  shared: `@probe/shared-${type}`,
  offered: `@probe/offered-${type}`,
});

let ctx: TestContext;
let otherTeam: string;

/** The detail's `availability`, checked against the library's cell for the same caller. */
async function read(as: TestContext, type: Kind, id: string) {
  const res = await app.request(`/api/packages/${SEGMENT[type]}/${id}`, {
    headers: authHeaders(as),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const detail = (await res.json()) as { active?: boolean; availability: Availability };

  const lib = await app.request(`/api/spaces/${as.defaultSpaceId}/library`, {
    headers: authHeaders(as),
  });
  expect(lib.status, await lib.clone().text()).toBe(200);
  const library = (await lib.json()) as {
    packages: Record<
      Kind,
      {
        id: string;
        offered_to_org: boolean;
        org_offerable: boolean;
        active_by_default: boolean;
        placements: {
          space_id: string;
          via: string;
          state: string;
          shared_by: Availability["shared_by"];
        }[];
      }[]
    >;
  };
  const entry = library.packages[type].find((p) => p.id === id)!;
  const placement = entry.placements.find((p) => p.space_id === as.defaultSpaceId)!;
  expect(detail.availability).toEqual({
    via: placement.via,
    state: placement.state,
    shared_by: placement.shared_by,
    offered_to_org: entry.offered_to_org,
    org_offerable: entry.org_offerable,
    active_by_default: entry.active_by_default,
  });
  if (type === "agent") expect(detail.active).toBe(detail.availability.state === "active");
  return detail.availability;
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  otherTeam = (await seedSpace({ orgId: ctx.orgId, name: "Other team" })).id;
  for (const type of ["agent", "skill"] as const) {
    const { homed, shared, offered } = ids(type);
    for (const [id, home] of [
      [homed, ctx.defaultSpaceId],
      [shared, otherTeam],
      [offered, otherTeam],
    ] as const) {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type,
        homeSpaceId: home,
        draftManifest: { name: id, version: "1.0.0", type, display_name: id },
        draftContent:
          type === "skill"
            ? `---\nname: ${id.split("/")[1]}\ndescription: Probe.\n---\n\nBody.`
            : "Prompt.",
      });
      // Outside its home a package is read at its latest published version.
      await seedPublishedVersion(id, "1.0.0");
    }
  }
});

for (const type of ["agent", "skill"] as const) {
  const { homed, shared, offered } = ids(type);

  describe(`GET /api/packages/${SEGMENT[type]}/{scope}/{name} — availability`, () => {
    it("reads `home` for a package homed in the space", async () => {
      const a = await read(ctx, type, homed);
      expect(a).toMatchObject({
        via: "home",
        shared_by: null,
        offered_to_org: false,
        active_by_default: false,
      });
    });

    it("reads `shared`, with who shared it, for a package homed elsewhere", async () => {
      await seedSpacePackage(ctx.defaultSpaceId, shared, {
        enabled: true,
        sharedBy: ctx.user.id,
      });
      const a = await read(ctx, type, shared);
      expect(a).toMatchObject({ via: "shared", state: "active" });
      expect(a.shared_by?.user_id).toBe(ctx.user.id);
    });

    it("reads `organization` and `active` for an offer with no row of the space's own", async () => {
      await seedOrgOffer(ctx.orgId, offered);
      const a = await read(ctx, type, offered);
      expect(a).toMatchObject({ via: "organization", state: "active", offered_to_org: true });
    });

    it("reads `inactive` once the space has switched the package off", async () => {
      await seedSpacePackage(ctx.defaultSpaceId, homed, { enabled: false });
      const a = await read(ctx, type, homed);
      expect(a).toMatchObject({ via: "home", state: "inactive" });
    });

    it("gives an owner the offer verdict", async () => {
      await seedOrgOffer(ctx.orgId, offered);
      expect((await read(ctx, type, offered)).org_offerable).toBe(true);
    });

    it("refuses the offer switch to a member holding only the read grants", async () => {
      const reader = await memberHolding(ctx, [`${SEGMENT[type]}:read`, "spaces:read"]);
      await seedOrgOffer(ctx.orgId, offered);
      const a = await read(reader, type, offered);
      expect(a).toMatchObject({ via: "organization", offered_to_org: true, org_offerable: false });
    });

    it("404s on a package homed in another space and placed nowhere else", async () => {
      const res = await app.request(`/api/packages/${SEGMENT[type]}/${shared}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
    });
  });
}

describe("GET /api/packages/agents/{scope}/{name} — summary read", () => {
  it("omits `availability` for a launcher holding `agents:run` without `agents:read`", async () => {
    const { homed } = ids("agent");
    const launcher = await memberHolding(ctx, ["agents:run", "spaces:read"]);
    const res = await app.request(`/api/packages/agents/${homed}`, {
      headers: authHeaders(launcher),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("availability");
    expect(body).toHaveProperty("active");
  });
});
