// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveAgentConnectionReadiness` must judge integration manifests at the
 * PINNED version, exactly like the run-kickoff 412 gate.
 *
 * The readiness endpoint's whole contract is "the UI's pre-run signal can never
 * disagree with the actual gate". The run freezes every declared integration to
 * a PUBLISHED version at kickoff (`freezeRunSpawnDependencies` →
 * `resolveRunIntegrationVersions`, #686) and seeds the shared manifest memo with
 * it. Readiness created the same memo but never seeded it, so its cascade fell
 * through to `fetchIntegrationManifest` → `packages.draft_manifest` and judged
 * auth keys / required scopes against the integration AUTHOR'S LIVE DRAFT while
 * the run judged them against the pinned version. #1178 closed the same gap on
 * the agent-manifest axis; this suite locks the integration-manifest axis.
 *
 * The fixture makes draft and pinned DISAGREE on a verdict-deciding fact: the
 * published 1.0.0 requires `search` to hold `read` + `write`, the (later
 * mutated) draft requires only `read`, and the sole connection is granted
 * `read`. Pinned ⇒ `insufficient_scopes` / `blocks_run: true`; draft ⇒ clean.
 * A fixture where the two agree would pass with or without the seeding and
 * prove nothing.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import { eq } from "drizzle-orm";
import { integrationConnections, packages } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { resolveAgentConnectionReadiness } from "../../../src/services/integration-pins-service.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion, seedInstalledPackage } from "../../helpers/seed.ts";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";

const INTEG = "@readyorg/integ";
const SERVER = "@readyorg/server";
const AGENT = "@readyorg/agent";

/**
 * Integration manifest whose `search` tool requires `requiredScopes` on the
 * oauth2 `primary` auth. That list is the verdict-deciding fact: it feeds
 * `missingScopesForConnection`, which turns a scope gap into
 * `insufficient_scopes` (and therefore `blocks_run`).
 */
function integManifest(version: string, requiredScopes: string[]) {
  return localIntegrationManifest({
    name: INTEG,
    version,
    serverName: SERVER,
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

/** Agent selecting the integration's `search` tool at an exact pin. */
function agentManifest(opts: { withIntegration: boolean }): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: AGENT,
    version: "1.0.0",
    display_name: "Readiness Agent",
    ...(opts.withIntegration
      ? {
          dependencies: { integrations: { [INTEG]: "1.0.0" } },
          integrations_configuration: { [INTEG]: { tools: ["search"] } },
        }
      : {}),
  };
}

describe("resolveAgentConnectionReadiness — integration manifests are read at the PIN", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "readyorg" });

    // Published 1.0.0 — what a run freezes the `1.0.0` pin to. `search` needs
    // read + write here.
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integManifest("1.0.0", ["read", "write"]),
    });
    await seedPackageVersion({
      packageId: INTEG,
      version: "1.0.0",
      manifest: integManifest("1.0.0", ["read", "write"]) as unknown as Record<string, unknown>,
    });
    // …and NOW the integration author edits their working copy, dropping the
    // `write` requirement. The published artifact is untouched; only the draft
    // moved. This is the drift the readiness verdict must ignore. (The sentinel
    // 9.9.9 makes an accidental draft read obvious in any manifest assertion.)
    await db
      .update(packages)
      .set({ draftManifest: integManifest("9.9.9", ["read"]) })
      .where(eq(packages.id, INTEG));
    await seedInstalledPackage(ctx.defaultSpaceId, INTEG);

    // One accessible oauth2 connection granted `read` only — sufficient for the
    // draft's requirement, short of the published one's.
    await db.insert(integrationConnections).values({
      integrationId: INTEG,
      authKey: "primary",
      accountId: "acct-readiness",
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { access_token: "tok" } }),
      scopesGranted: ["read"],
    });
  });

  it("blocks the run on the PINNED manifest's required scopes, not the draft's", async () => {
    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      type: "agent",
      source: "local",
      draftManifest: agentManifest({ withIntegration: true }),
    });

    const readiness = await resolveAgentConnectionReadiness({
      scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      agentPackageId: AGENT,
      actor: { type: "user", id: ctx.user.id },
      isAdmin: true,
    });

    // THE negative control. Unseeded, the cascade reads the draft (which needs
    // only `read`, and the connection has it) and reports a clean verdict.
    expect(readiness.blocks_run).toBe(true);
    expect(readiness.errors).toHaveLength(1);
    expect(readiness.errors[0]?.code).toBe("insufficient_scopes");
    expect(readiness.errors[0]?.field).toBe(`integrations.${INTEG}`);
    expect(readiness.integrations[0]?.run_blocking).toBe(true);
    // The management DTO comes from the SECOND (`includeInert: true`) cascade
    // plus a per-integration pick — all three read the same memo, so the scope
    // gap has to be the pinned manifest's here too.
    expect(readiness.integrations[0]?.resolution.resolved_missing_scopes).toEqual(["write"]);
  });

  it("keeps the `version` selector honest: draft agent vs published agent", async () => {
    // The selector picks the AGENT manifest, never the integration one. The
    // published agent declares no integration at all; the draft declares one.
    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      type: "agent",
      source: "local",
      draftManifest: agentManifest({ withIntegration: true }),
    });
    await seedPackageVersion({
      packageId: AGENT,
      version: "1.0.0",
      manifest: agentManifest({ withIntegration: false }),
    });

    const base = {
      scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      agentPackageId: AGENT,
      actor: { type: "user", id: ctx.user.id } as const,
      isAdmin: true,
    };

    // `draft` still reads the working copy — one declared integration, and the
    // pinned-manifest verdict above.
    const draft = await resolveAgentConnectionReadiness({ ...base, version: "draft" });
    expect(draft.integrations.map((i) => i.integration_id)).toEqual([INTEG]);
    expect(draft.blocks_run).toBe(true);

    // The published agent manifest declares nothing to connect.
    const published = await resolveAgentConnectionReadiness({ ...base, version: "1.0.0" });
    expect(published.integrations).toEqual([]);
    expect(published.blocks_run).toBe(false);
  });
});
