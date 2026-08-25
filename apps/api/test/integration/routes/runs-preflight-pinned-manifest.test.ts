// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/agents/:scope/:name/run — the preflight readiness pass must judge
 * integration manifests at the PIN, not at the integration author's draft.
 *
 * The route builds one request-scoped `manifestCache` and hands it to
 * `resolveRunPreflight` (advisory 412) and then to `prepareAndExecuteRun`
 * (authoritative Step 2a freeze + Step 2b cascade). Only the pipeline seeded
 * it, so the preflight fell through to `packages.draft_manifest` while the
 * gates it precedes read the pinned published version.
 *
 * The damaging direction is the FALSE NEGATIVE, and it is the one this suite
 * pins down: pinned manifest SATISFIABLE, draft NOT. Pre-fix the launch was
 * refused with a 412 naming scopes the version actually being run does not
 * require, and it never reached Step 2b to be judged correctly — a user whose
 * pinned integration is perfectly fine simply could not launch.
 *
 * The mirror direction (draft ready, pinned not) needs no test here: Step 2b
 * re-runs the cascade over the seeded, pinned manifests and raises the 412
 * itself, which `runs-412-missing-connection.test.ts` already covers.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { integrationConnections, packages } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const AGENT = "@pinrun/agent";
const INTEG = "@pinrun/svc";

/**
 * `search` requires `requiredScopes` on the oauth2 `primary` auth — the fact
 * the 412 verdict turns on, via `missingScopesForConnection`.
 */
function integManifest(version: string, requiredScopes: string[]) {
  return localIntegrationManifest({
    name: INTEG,
    version,
    serverName: "@pinrun/svc-server",
    auths: {
      primary: {
        type: "oauth2",
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        defaultScopes: ["read"],
        scopeCatalog: [
          { value: "read", label: "Read" },
          { value: "write", label: "Write" },
        ],
      },
    },
    tools_policy: { search: { required_scopes: { primary: requiredScopes } } },
  });
}

interface ProblemDetails {
  status?: number;
  code?: string;
  errors?: Array<{ field: string; code: string; missing_scopes?: string[] }>;
}

describe("POST /api/agents/:scope/:name/run — preflight reads the PINNED integration manifest", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pinrun" });

    // Published 1.0.0 — what the run freezes the `1.0.0` pin to. `search`
    // needs `read` here, which the connection below has.
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integManifest("1.0.0", ["read"]),
    });
    await seedPackageVersion({
      packageId: INTEG,
      version: "1.0.0",
      manifest: integManifest("1.0.0", ["read"]) as unknown as Record<string, unknown>,
    });
    // …and NOW the integration author tightens their WORKING COPY to also
    // demand `write`. Nothing about the published artifact changed, so nothing
    // about this run changed — but the unseeded preflight read this.
    await db
      .update(packages)
      .set({ draftManifest: integManifest("9.9.9", ["read", "write"]) })
      .where(eq(packages.id, INTEG));
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, INTEG);

    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.2",
        display_name: "Pinned Integration Agent",
        dependencies: { integrations: { [INTEG]: "1.0.0" } },
        integrations_configuration: { [INTEG]: { tools: ["search"] } },
      },
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);

    // One accessible oauth2 connection granted `read` only: enough for the
    // pinned manifest, short of the drifted draft's demand.
    await db.insert(integrationConnections).values({
      integrationId: INTEG,
      authKey: "primary",
      accountId: "acct-pinrun",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { access_token: "tok" } }),
      scopesGranted: ["read"],
    });
  });

  it("does not 412 when the pinned version is satisfiable and only the draft drifted", async () => {
    const res = await app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // 412 is reserved exclusively for the missing_integration_connection
    // envelope (same reasoning as the must_choose retry assertion in
    // runs-412-missing-connection.test.ts), so `not 412` directly proves the
    // preflight judged the pinned manifest. The launch dies further downstream
    // on model configuration (400) — that is fine and deliberately not asserted
    // on: this suite owns the readiness verdict, not the whole kickoff.
    const body = (await res.json()) as ProblemDetails;
    expect(res.status).not.toBe(412);
    expect(body.code).not.toBe("missing_integration_connection");
    // And nothing anywhere in the response blames this integration — the
    // reverted code answers `insufficient_scopes` / `missing_scopes: ["write"]`
    // on exactly this field.
    expect(body.errors?.filter((e) => e.field === `integrations.${INTEG}`) ?? []).toEqual([]);
  });
});
