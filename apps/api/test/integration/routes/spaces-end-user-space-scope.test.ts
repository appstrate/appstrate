// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1313 — a credential PINNED to one space must not reach another space
 * through a `/api/spaces/:spaceId/*` path param.
 *
 * The API-key half of that invariant is covered in `spaces.test.ts` (issue #172
 * extension). This file covers the OIDC end-user half: a token that pins a
 * space, carries NO `orgRole`, and holds `agents:read` — the one end-user
 * grantable string among the space-package routes. `applySpacePermissions`
 * returns early for a role-less caller, so before the fix nothing compared the
 * path space to the pinned one and `run-config` handed back the target space's
 * stored input values, `locked_fields` included, for `private` spaces too.
 *
 * The strategy is a stub rather than the OIDC module: the shape that matters is
 * `{ orgId, spaceId, no orgRole, permissions }`, which is exactly what
 * `apps/api/src/modules/oidc/auth/strategy.ts` resolves for an end-user JWT.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace } from "../../helpers/seed.ts";
import { spacePackages } from "@appstrate/db/schema";
import type { AppstrateModule, AuthStrategy } from "@appstrate/core/module";

let currentCtx: TestContext | null = null;

/** Mints the end-user shape, pinned to the space named in the header. */
const endUserStrategy: AuthStrategy = {
  id: "stub-end-user-strategy",
  async authenticate({ headers }) {
    const pinnedSpaceId = headers.get("x-stub-end-user-space");
    if (!pinnedSpaceId) return null;
    if (!currentCtx) throw new Error("currentCtx not seeded — test setup bug");
    return {
      user: {
        id: currentCtx.user.id,
        email: currentCtx.user.email,
        name: currentCtx.user.name,
      },
      orgId: currentCtx.orgId,
      orgSlug: currentCtx.org.slug,
      // No `orgRole` on purpose — an end-user is not an org member.
      authMethod: "stub-end-user",
      spaceId: pinnedSpaceId,
      permissions: ["agents:read"],
      endUser: {
        id: "eu_stub_end_user_placeholder",
        spaceId: pinnedSpaceId,
        name: "Stub End User",
        email: "stub-end-user@test.com",
      },
    };
  },
};

const stubModule: AppstrateModule = {
  manifest: { id: "stub-end-user-strategy", name: "Stub End User Strategy", version: "1.0.0" },
  async init() {},
  authStrategies() {
    return [endUserStrategy];
  },
};

const app = getTestApp({ modules: [stubModule] });

const AGENT_ID = "@testorg/agent";
const RUN_CONFIG = `/packages/${AGENT_ID}/run-config`;

describe("an end-user token pinned to a space and the spaces router (issue #1313)", () => {
  let otherSpaceId: string;

  beforeEach(async () => {
    await truncateAll();
    currentCtx = await createTestContext({ orgSlug: "testorg" });
    const otherSpace = await seedSpace({
      orgId: currentCtx.orgId,
      name: "Private Space",
      visibility: "private",
    });
    otherSpaceId = otherSpace.id;
    await seedPackage({
      orgId: currentCtx.orgId,
      id: AGENT_ID,
      type: "agent",
      draftManifest: { name: AGENT_ID, version: "1.0.0", type: "agent" },
    });
    await db.insert(spacePackages).values([
      {
        spaceId: currentCtx.defaultSpaceId,
        packageId: AGENT_ID,
        inputSettings: { values: { folder: "own-space" }, locked: ["folder"] },
      },
      {
        spaceId: otherSpaceId,
        packageId: AGENT_ID,
        inputSettings: { values: { api_token: "SECRET-FROM-OTHER-SPACE" }, locked: ["api_token"] },
      },
    ]);
  });

  it("refuses run-config for a space it is not pinned to, private included", async () => {
    const res = await app.request(`/api/spaces/${otherSpaceId}${RUN_CONFIG}`, {
      headers: { "X-Stub-End-User-Space": currentCtx!.defaultSpaceId },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("SECRET-FROM-OTHER-SPACE");
  });

  it("still reads run-config for the space it is pinned to", async () => {
    const res = await app.request(`/api/spaces/${currentCtx!.defaultSpaceId}${RUN_CONFIG}`, {
      headers: { "X-Stub-End-User-Space": currentCtx!.defaultSpaceId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.input).toEqual({ values: { folder: "own-space" }, locked_fields: ["folder"] });
  });
});
