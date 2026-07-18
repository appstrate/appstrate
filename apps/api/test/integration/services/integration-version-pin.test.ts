// SPDX-License-Identifier: Apache-2.0

/**
 * Integration manifest version resolution on the run path (issue #686).
 *
 * `resolveRunIntegrationVersions` resolves every declared integration's
 * manifest against PUBLISHED versions honoring its `dependencies.integrations.<id>`
 * pin (and per-run `dependency_overrides`), the integration-axis mirror of the
 * skill closure fix (#666) and `resolveMcpServerForSpawn` (#588). It:
 *   - seeds the shared manifest cache with the PINNED manifest so every kickoff
 *     reader (connection cascade, spawn resolver) honors the pin transparently,
 *   - returns the frozen `{ version, source }` map persisted on the run row,
 *   - fails loud (`unresolved`) on an unsatisfiable / never-published pin
 *     instead of silently falling back to the mutable draft.
 *
 * `readIntegrationManifestAt` is the single manifest reader used both when
 * seeding the cache and on the runtime credential path, so a mid-run MITM
 * refresh reads the SAME version the spawn used. This suite locks both.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  resolveRunIntegrationVersions,
  readIntegrationManifestAt,
  resolvedIntegrationVersionToDescriptor,
  type IntegrationManifestCache,
} from "../../../src/services/integration-service.ts";
import { freezeRunSpawnDependencies } from "../../../src/services/run-pipeline.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import type { LoadedPackage } from "../../../src/types/index.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";

const INTEG = "@pinorg/integ";
const SERVER = "@pinorg/server";

/** A valid integration manifest stamped with `version` so a test can prove
 *  WHICH version's manifest was read (published vs the draft marker). */
function integManifest(version: string) {
  return localIntegrationManifest({
    name: INTEG,
    version,
    serverName: SERVER,
    auths: {
      key: {
        type: "api_key",
        authorizedUris: ["https://api.example.com/**"],
        credentialFields: ["api_key"],
        delivery: { env: { API_KEY: { value: "{$credential.api_key}", sensitive: true } } },
      },
    },
    tools_policy: { search: {} },
  });
}

/** Agent declaring INTEG at `pin`. */
function agentManifest(pin: string): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: "@pinorg/agent",
    version: "1.0.0",
    display_name: "Agent",
    dependencies: { integrations: { [INTEG]: pin } },
    integrations_configuration: { [INTEG]: { tools: ["search"] } },
  };
}

/** Seed the integration package with a DRAFT manifest carrying a sentinel
 *  version (9.9.9) that no published version uses — any reader that returns
 *  9.9.9 read the draft, not the pinned published version. */
async function seedDraft(ctx: TestContext) {
  await seedPackage({
    id: INTEG,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: integManifest("9.9.9"),
  });
}

async function seedPublished(version: string) {
  await seedPackageVersion({
    packageId: INTEG,
    version,
    manifest: integManifest(version),
  });
}

describe("resolveRunIntegrationVersions — integration manifest pin (#686)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pinorg" });
  });

  it("resolves the pin to the highest in-range published version, NOT the draft", async () => {
    await seedDraft(ctx);
    await seedPublished("1.0.0");
    await seedPublished("1.5.0");
    await seedPublished("2.0.0"); // out of `^1.0.0` range

    const cache: IntegrationManifestCache = new Map();
    const res = await resolveRunIntegrationVersions({
      orgId: ctx.orgId,
      agentManifest: agentManifest("^1.0.0"),
      manifestCache: cache,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Highest satisfying `^1.0.0` is 1.5.0 — never 2.0.0 (latest) or 9.9.9 (draft).
    expect(res.versions[INTEG]).toEqual({ version: "1.5.0", source: "version" });

    // The shared cache is seeded with the PUBLISHED manifest, so every kickoff
    // reader threading it (connection cascade, spawn resolver) gets the pin.
    const cached = await cache.get(INTEG);
    expect(cached?.ok).toBe(true);
    if (cached?.ok) expect(cached.manifest.version).toBe("1.5.0");
  });

  it("exact pin selects that version", async () => {
    await seedDraft(ctx);
    await seedPublished("1.0.0");
    await seedPublished("1.5.0");

    const res = await resolveRunIntegrationVersions({
      orgId: ctx.orgId,
      agentManifest: agentManifest("1.0.0"),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.versions[INTEG]).toEqual({ version: "1.0.0", source: "version" });
  });

  it("`dependency_overrides[id] = draft` routes the integration to its working copy", async () => {
    await seedDraft(ctx);
    await seedPublished("1.0.0");

    const cache: IntegrationManifestCache = new Map();
    const res = await resolveRunIntegrationVersions({
      orgId: ctx.orgId,
      agentManifest: agentManifest("^1.0.0"),
      dependencyOverrides: { [INTEG]: "draft" },
      manifestCache: cache,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.versions[INTEG]).toEqual({ version: null, source: "draft" });
    // The cache now serves the DRAFT manifest (sentinel 9.9.9), not 1.0.0.
    const cached = await cache.get(INTEG);
    expect(cached?.ok).toBe(true);
    if (cached?.ok) expect(cached.manifest.version).toBe("9.9.9");
  });

  it("a non-draft `dependency_overrides[id]` replaces the manifest pin", async () => {
    await seedDraft(ctx);
    await seedPublished("1.0.0");
    await seedPublished("2.0.0");

    // Manifest pins `^1.0.0` (would pick 1.0.0), override forces 2.0.0.
    const res = await resolveRunIntegrationVersions({
      orgId: ctx.orgId,
      agentManifest: agentManifest("^1.0.0"),
      dependencyOverrides: { [INTEG]: "2.0.0" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.versions[INTEG]).toEqual({ version: "2.0.0", source: "version" });
  });

  it("an unsatisfiable pin fails loud (unresolved), never a silent draft fallback", async () => {
    await seedDraft(ctx);
    await seedPublished("1.0.0"); // only 1.0.0; pin wants ^3.0.0

    const res = await resolveRunIntegrationVersions({
      orgId: ctx.orgId,
      agentManifest: agentManifest("^3.0.0"),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.unresolved).toEqual([{ name: INTEG, versionSpec: "^3.0.0" }]);
  });

  it("a never-published integration with a pin is unresolved", async () => {
    await seedDraft(ctx); // draft only, no published versions

    const res = await resolveRunIntegrationVersions({
      orgId: ctx.orgId,
      agentManifest: agentManifest("^1.0.0"),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.unresolved[0]?.name).toBe(INTEG);
  });

  // freezeRunSpawnDependencies is the shared kickoff unit BOTH origins use —
  // platform (`prepareAndExecuteRun`) and remote (`run-creation.createRun`).
  // Locking it here covers the remote path's enforcement without standing up
  // the readiness/connection cascade: remote calls the identical function.
  describe("freezeRunSpawnDependencies — shared origin gate", () => {
    function agentPkg(pin: string): LoadedPackage {
      return { manifest: agentManifest(pin) } as unknown as LoadedPackage;
    }

    it("freezes the satisfiable pin to the published version", async () => {
      await seedDraft(ctx);
      await seedPublished("1.0.0");
      await seedPublished("1.5.0");

      const versions = await freezeRunSpawnDependencies({
        orgId: ctx.orgId,
        agent: agentPkg("^1.0.0"),
      });
      expect(versions[INTEG]).toEqual({ version: "1.5.0", source: "version" });
    });

    it("throws dependency_unresolved (422) on an unsatisfiable pin — same as remote", async () => {
      await seedDraft(ctx);
      await seedPublished("1.0.0");

      const err = await freezeRunSpawnDependencies({
        orgId: ctx.orgId,
        agent: agentPkg("^3.0.0"),
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      expect((err as ApiError).code).toBe("dependency_unresolved");
    });

    it("throws 400 on a dependency_overrides key the agent does not declare", async () => {
      await seedDraft(ctx);
      await seedPublished("1.0.0");

      const err = await freezeRunSpawnDependencies({
        orgId: ctx.orgId,
        agent: agentPkg("^1.0.0"),
        dependencyOverrides: { "@pinorg/not-declared": "draft" },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
    });
  });

  it("runtime parity: readIntegrationManifestAt reads the SAME version the snapshot froze", async () => {
    await seedDraft(ctx);
    await seedPublished("1.0.0");
    await seedPublished("1.5.0");

    const res = await resolveRunIntegrationVersions({
      orgId: ctx.orgId,
      agentManifest: agentManifest("^1.0.0"),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const frozen = res.versions[INTEG]!;

    // The runtime credential path reads the manifest AT the frozen descriptor —
    // it must see 1.5.0, identical to what the spawn cache was seeded with.
    const manifest = await readIntegrationManifestAt(
      INTEG,
      resolvedIntegrationVersionToDescriptor(frozen),
    );
    expect(manifest.ok).toBe(true);
    if (manifest.ok) expect(manifest.manifest.version).toBe("1.5.0");
  });
});
