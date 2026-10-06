// SPDX-License-Identifier: Apache-2.0

/**
 * The SPA's `teamSpaceOnly` route flags (`apps/web/src/lib/route-access.ts`)
 * pinned to the server: a flagged page disappears in a personal space, so the
 * write it exists for must be one the server refuses there by rule (409
 * `personal_space_*`, RBAC spec §3.6) — and a page left unflagged must be one
 * whose write still works. Flagging a route with no refusal behind it hides a
 * usable page; this suite fails until the route has an entry here.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { getModules } from "../../../src/lib/modules/module-loader.ts";
import { ROUTE_ACCESS } from "../../../../web/src/lib/route-access.ts";

const app = getTestApp();

type Declaration = { feature?: string; teamSpaceOnly?: true };
const flagged = Object.entries(ROUTE_ACCESS as Record<string, Declaration>)
  .filter(([, access]) => access.teamSpaceOnly)
  .map(([path, access]) => ({ path, feature: access.feature }));

const loadedFeatures = new Set(
  [...getModules().values()].flatMap((mod) => Object.keys(mod.features ?? {})),
);

const json = (ctx: TestContext, spaceId: string) => ({
  ...authHeaders(ctx, { "X-Space-Id": spaceId }),
  "Content-Type": "application/json",
});

/** The create each flagged page is for, sent in the caller's own personal space. */
const CREATE_IN_PERSONAL_SPACE: Record<
  string,
  (ctx: TestContext, personalId: string) => Response | Promise<Response>
> = {
  "/org-settings/space/members": async (ctx, personalId) => {
    const colleague = await createTestUser();
    await addOrgMember(ctx.orgId, colleague.id, "member");
    return app.request(`/api/spaces/${personalId}/members`, {
      method: "POST",
      headers: json(ctx, personalId),
      body: JSON.stringify({ userId: colleague.id, preset_role: "viewer" }),
    });
  },
  "/org-settings/space/api-keys": (ctx, personalId) =>
    app.request("/api/api-keys", {
      method: "POST",
      headers: json(ctx, personalId),
      body: JSON.stringify({ name: "headless", scopes: ["agents:read"] }),
    }),
  "/org-settings/space/oauth": (ctx, personalId) =>
    app.request("/api/oauth/clients", {
      method: "POST",
      headers: json(ctx, ctx.defaultSpaceId),
      body: JSON.stringify({
        level: "space",
        name: "Portal",
        redirectUris: ["https://acme.example.com/oauth/callback"],
        referencedSpaceId: personalId,
      }),
    }),
  "/end-users": (ctx, personalId) =>
    app.request("/api/end-users", {
      method: "POST",
      headers: json(ctx, personalId),
      body: JSON.stringify({ externalId: "ext-1" }),
    }),
};

describe("SPA teamSpaceOnly routes ↔ personal-space refusals", () => {
  let ctx: TestContext;
  let personalId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "teamonly" });
    // The listing provisions the caller's personal space.
    const res = await app.request("/api/spaces", { headers: authHeaders(ctx) });
    const { data } = (await res.json()) as { data: { id: string; personal: boolean }[] };
    personalId = data.find((space) => space.personal)!.id;
  });

  it("pins every flagged route to a create, and no other", () => {
    expect(flagged.length).toBeGreaterThan(0);
    expect(Object.keys(CREATE_IN_PERSONAL_SPACE).sort()).toEqual(
      flagged.map((route) => route.path).sort(),
    );
  });

  for (const route of flagged) {
    const unloaded = route.feature !== undefined && !loadedFeatures.has(route.feature);
    it.skipIf(unloaded)(`${route.path}: its create is refused in a personal space`, async () => {
      const res = await CREATE_IN_PERSONAL_SPACE[route.path]!(ctx, personalId);
      const problem = await expectProblem(res, 409);
      expect(problem.code).toMatch(/^personal_space_/);
    });
  }

  it("CONTROL: an unflagged space page keeps its write in a personal space", async () => {
    // `/org-settings/space/general` stays: renaming one's own space is allowed.
    expect("teamSpaceOnly" in ROUTE_ACCESS["/org-settings/space/general"]).toBe(false);
    const res = await app.request(`/api/spaces/${personalId}`, {
      method: "PATCH",
      headers: json(ctx, personalId),
      body: JSON.stringify({ name: "Brouillons" }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });
});
