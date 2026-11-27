// SPDX-License-Identifier: Apache-2.0

/**
 * An inline run launched from a space where the integration it requires is NOT active answers the
 * same actionable 409 `integration_not_active` to every credential. The integration is homed in
 * another team space and not placed in the caller's personal space; the caller holds an
 * organization-scope connection to it and names it in `connection_overrides`.
 *
 * A credential bound to a SET of spaces (the chat's loopback bearer) enters ONE space per request,
 * so the dependency check, judged over the entered space alone, used to answer an opaque
 * `404 Package not found` where a session got the 409.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import { integrationConnections, runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { loopbackHeaders } from "../../helpers/loopback.ts";
import {
  createFakeOrchestrator,
  seedDefaultOrgModel,
  waitForRunPipelineSettled,
  inlineAgentManifest,
  seedConnectionTestIntegration,
} from "../../helpers/run-connection-fixtures.ts";
import { installRuntimeBoundSystemPackages } from "../../helpers/runtime-bound-system-packages.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import { orgPermissions, presetPermissions } from "../../../src/lib/permissions.ts";
import { ensurePersonalSpaceFor } from "../../../src/services/spaces.ts";

const app = getTestApp();
const INTEGRATION = "@alpha/integ-cle";

let ctx: TestContext;
let personalId: string;
let connectionId: string;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "alpha" });
  personalId = (await ensurePersonalSpaceFor(ctx.orgId, ctx.user.id)).id;
  // Homed and active in the team space Default only.
  await seedConnectionTestIntegration(ctx, INTEGRATION);
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: "acct-org",
      orgId: ctx.orgId,
      spaceId: null, // organization scope: usable in every space
      userId: ctx.user.id,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret-value" } }),
      scopesGranted: [],
      label: "Ma connexion",
    })
    .returning({ id: integrationConnections.id });
  connectionId = row!.id;
});

function launch(headers: Record<string, string>) {
  return app.request("/api/runs/inline", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      manifest: inlineAgentManifest([INTEGRATION], { required: [INTEGRATION] }),
      prompt: "use the existing connection",
      connection_overrides: { [INTEGRATION]: [connectionId] },
    }),
  });
}

function chatBearer(spaceIds: string[]) {
  return {
    ...loopbackHeaders(ctx, ctx.orgId, {
      orgRole: "owner",
      permissions: [...orgPermissions("owner"), ...presetPermissions("admin"), "mcp:read"],
      spaceIds,
      restricted: false,
    }),
    "X-Space-Id": personalId,
  };
}

async function expectInactive(res: Response) {
  const body = (await res.json()) as {
    code: string;
    errors?: { code: string }[];
    active_in_spaces?: { id: string }[];
  };
  expect(res.status).toBe(409);
  expect(body.code).toBe("missing_integration_connection");
  expect(body.errors?.map((e) => e.code)).toContain("integration_not_active");
  expect(body.active_in_spaces?.map((s) => s.id)).toEqual([ctx.defaultSpaceId]);
}

describe("POST /api/runs/inline — a required integration inactive in the entered space", () => {
  it("answers a session with the actionable 409", async () => {
    await expectInactive(await launch({ ...authHeaders(ctx), "X-Space-Id": personalId }));
  });

  it("answers the chat's loopback bearer with the same 409, not a 404", async () => {
    await expectInactive(await launch(chatBearer([personalId, ctx.defaultSpaceId])));
  });

  it("runs in the personal space with the same named connection once the owner offers the integration", async () => {
    const headers = chatBearer([personalId, ctx.defaultSpaceId]);
    const restore = await installRuntimeBoundSystemPackages();
    _setOrchestratorForTesting(createFakeOrchestrator());
    try {
      await seedDefaultOrgModel(ctx);
      await expectInactive(await launch(headers));
      const offered = await app.request(`/api/packages/${INTEGRATION}/org-offer`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ org_offer: "on_by_default" }),
      });
      expect(offered.status).toBe(201);
      const result = await launch(headers);
      expect(result.status, await result.clone().text()).toBe(201);
      const [run] = await db.select().from(runs);
      expect(run).toMatchObject({
        spaceId: personalId,
        resolvedConnections: {
          [INTEGRATION]: [{ connectionId, source: "run_override" }],
        },
      });
    } finally {
      await waitForRunPipelineSettled();
      restore();
      _setOrchestratorForTesting(null);
    }
  });

  it("keeps a package outside the bearer's own spaces unreachable (404)", async () => {
    const res = await launch(chatBearer([personalId]));
    expect(res.status).toBe(404);
  });
});
