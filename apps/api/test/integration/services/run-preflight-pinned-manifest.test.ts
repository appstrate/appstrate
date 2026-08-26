// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveRunPreflight` — the shared preflight for BOTH platform origins (the
 * run route and `triggerScheduledRun`) — must judge integration manifests at
 * the pin, not at the integration author's draft.
 *
 * Readiness reads each declared integration's manifest through a shared memo
 * (manifest-health gate, install/enable gate, connection cascade). Unseeded,
 * `fetchIntegrationManifest` falls through to `packages.draft_manifest`, so the
 * verdict tracked the author's live working copy while the kickoff gates that
 * follow it judged the pinned published version.
 *
 * This suite exercises the SCHEDULER'S CALL SHAPE specifically — no
 * `manifestCache` argument at all, which is what `scheduler.ts` passes. The
 * scheduler is the severe case: `triggerScheduledRun` turns any `ApiError` from
 * this function into `failSchedule(...)`, so a background schedule with no user
 * in the loop stops firing because someone edited a draft. The scheduler's own
 * suite is `describeRequiresRedis` and cannot run at tier 0, so the coverage
 * here is unit-level equivalence on the exact call it makes, not end-to-end.
 *
 * Direction under test is the FALSE NEGATIVE: pinned manifest SATISFIABLE,
 * draft NOT. The mirror direction is caught downstream by run-pipeline Step 2b
 * and covered by `runs-412-missing-connection.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/space-packages.ts";
import { getPackage } from "../../../src/services/package-catalog.ts";
import { resolveRunPreflight } from "../../../src/services/run-pipeline.ts";
import type { IntegrationManifestCache } from "../../../src/services/integration-service.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { integrationConnections, packages } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";
import type { LoadedPackage } from "../../../src/types/index.ts";

const AGENT = "@schedpin/agent";
const INTEG = "@schedpin/svc";

/** `search` requires `requiredScopes` on the oauth2 `primary` auth — the fact
 *  the readiness verdict turns on, via `missingScopesForConnection`. */
function integManifest(version: string, requiredScopes: string[]) {
  return localIntegrationManifest({
    name: INTEG,
    version,
    serverName: "@schedpin/svc-server",
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

describe("resolveRunPreflight — integration manifests are read at the PIN", () => {
  let ctx: TestContext;
  let agent: LoadedPackage;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "schedpin" });

    // Published 1.0.0 — what the run freezes the `1.0.0` pin to. `search` needs
    // `read`, which the connection below has.
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
    // …and NOW the author tightens their WORKING COPY to also demand `write`.
    // The published artifact is untouched, so nothing about this run changed.
    // The sentinel version 9.9.9 makes an accidental draft read visible.
    await db
      .update(packages)
      .set({ draftManifest: integManifest("9.9.9", ["read", "write"]) })
      .where(eq(packages.id, INTEG));
    await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEG);

    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.2",
        display_name: "Scheduled Pinned Agent",
        dependencies: { integrations: { [INTEG]: "1.0.0" } },
        integrations_configuration: { [INTEG]: { tools: ["search"] } },
      },
    });
    await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);

    // One accessible oauth2 connection granted `read` only: enough for the
    // pinned manifest, short of the drifted draft's demand.
    await db.insert(integrationConnections).values({
      integrationId: INTEG,
      authKey: "primary",
      accountId: "acct-schedpin",
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { access_token: "tok" } }),
      scopesGranted: ["read"],
    });

    agent = (await getPackage(AGENT, ctx.orgId))!;
  });

  type PreflightArgs = Parameters<typeof resolveRunPreflight>[0];

  /** The shared call every case below varies one argument of. */
  async function preflight(extra: Partial<PreflightArgs> = {}) {
    return resolveRunPreflight({
      agent,
      spaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      actor: { type: "user", id: ctx.user.id },
      ...extra,
    });
  }

  it("scheduler call shape (no manifestCache) resolves against the pin, not the draft", async () => {
    // `scheduler.ts:triggerScheduledRun` passes no memo. Unseeded, the draft's
    // `write` requirement wins and this throws 412 — which the scheduler
    // converts into `failSchedule(...)`, permanently stopping a schedule whose
    // pinned version is perfectly runnable. The preflight returns nothing —
    // passing IS resolving.
    await expect(preflight()).resolves.toBeUndefined();
  });

  it("a caller-supplied memo is the one seeded — no second Map behind its back", async () => {
    const cache: IntegrationManifestCache = new Map();
    await preflight({ manifestCache: cache });

    // The route shares this Map with the snapshot + spawn passes; if the
    // preflight had seeded a private Map, this one would still be empty (or
    // hold the draft) and the sharing contract would be silently broken.
    expect(cache.size).toBe(1);
    const cached = await cache.get(INTEG);
    expect(cached?.ok).toBe(true);
    if (cached?.ok) expect(cached.manifest.version).toBe("1.0.0");
  });

  it("`dependency_overrides` are honoured — a run pinned to the working copy is judged on it", async () => {
    // A schedule may carry `package_schedules.dependency_overrides`, and the
    // route accepts them per run. Routing this integration to `draft` must make
    // readiness judge the draft — which demands `write` the connection lacks.
    const err = await preflight({ dependencyOverrides: { [INTEG]: "draft" } }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(412);
    expect((err as ApiError).code).toBe("missing_integration_connection");
  });
});
