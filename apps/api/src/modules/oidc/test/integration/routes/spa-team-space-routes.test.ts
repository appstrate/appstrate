// SPDX-License-Identifier: Apache-2.0

/**
 * The SPA's `teamSpaceOnly` flags on OIDC pages (`apps/web/src/lib/route-access.ts`),
 * pinned to the server: a flagged page disappears in a personal space, so the
 * write it exists for must be one the server refuses there by rule (409
 * `personal_space_*`). The core suite pins the flags of core pages; this one
 * pins the pages of the `oidc` feature and fails until each has an entry here.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { expectProblem } from "../../../../../../test/helpers/assertions.ts";
import {
  authHeaders,
  createTestContext,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { ROUTE_ACCESS } from "../../../../../../../web/src/lib/route-access.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

type Declaration = { feature?: string; teamSpaceOnly?: true };
const flagged = Object.entries(ROUTE_ACCESS as Record<string, Declaration>)
  .filter(([, access]) => access.teamSpaceOnly && access.feature === "oidc")
  .map(([path]) => path);

/** The create each flagged page is for, aimed at the caller's own personal space. */
const CREATE_IN_PERSONAL_SPACE: Record<
  string,
  (ctx: TestContext, personalId: string) => Response | Promise<Response>
> = {
  "/org-settings/space/oauth": (ctx, personalId) =>
    app.request("/api/oauth/clients", {
      method: "POST",
      headers: {
        ...authHeaders(ctx, { "X-Space-Id": ctx.defaultSpaceId }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        level: "space",
        name: "Portal",
        redirectUris: ["https://acme.example.com/oauth/callback"],
        referencedSpaceId: personalId,
      }),
    }),
};

describe("SPA teamSpaceOnly OIDC routes ↔ personal-space refusals", () => {
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

  it("pins every flagged OIDC route to a create, and no other", () => {
    expect(flagged.length).toBeGreaterThan(0);
    expect(Object.keys(CREATE_IN_PERSONAL_SPACE).sort()).toEqual([...flagged].sort());
  });

  for (const path of flagged) {
    it(`${path}: its create is refused in a personal space`, async () => {
      const res = await CREATE_IN_PERSONAL_SPACE[path]!(ctx, personalId);
      const problem = await expectProblem(res, 409);
      expect(problem.code).toMatch(/^personal_space_/);
    });
  }
});
