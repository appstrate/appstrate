// SPDX-License-Identifier: Apache-2.0

/**
 * CRIT-11 regression — `resolvePublishedManifest` (the single spawn-time
 * version-resolution kernel) is ORG-SCOPED.
 *
 * A required `orgId` now lands in the SQL WHERE of BOTH the package-metadata
 * lookup and the version lookup (`orgOrSystemFilter`), so a run can only ever
 * resolve a package its org owns or a system package (`org_id IS NULL`). If
 * the filter is reverted, a run in org A referencing an integration
 * PUBLISHED BY ORG B would happily feed org B's manifest
 * (and its bytes) into org A's spawn path.
 *
 * The kernel is private; it is exercised through its exported wrapper
 * `resolveRunIntegrationVersions` (#686)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion, seedPublishedVersion } from "../../helpers/seed.ts";
import {
  resolveConnectBundleVersion,
  resolveRunIntegrationVersions,
  type IntegrationManifestCache,
} from "../../../src/services/integration-service.ts";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";

const INTEG = "@tenantb/integ";
const SYSTEM_INTEG = "@shared/system-integ";

function integManifest(version: string) {
  return localIntegrationManifest({
    name: INTEG,
    version,
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

/** Agent (in the CALLING org) declaring INTEG at `pin`. */
function agentManifest(pin: string): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: "@tenanta/agent",
    version: "1.0.0",
    display_name: "Agent",
    dependencies: { integrations: { [INTEG]: pin } },
    integrations_configuration: { [INTEG]: { tools: ["search"] } },
  };
}

describe("resolvePublishedManifest — tenant boundary (CRIT-11)", () => {
  let orgA: TestContext; // the run's org — must NOT see org B's packages
  let orgB: TestContext; // the owning org

  beforeEach(async () => {
    await truncateAll();
    orgA = await createTestContext({ orgSlug: "tenanta", email: "a@tenant.test" });
    orgB = await createTestContext({ orgSlug: "tenantb", email: "b@tenant.test" });
  });

  describe("connect bundle version (resolveConnectBundleVersion)", () => {
    beforeEach(async () => {
      await seedPackage({
        id: INTEG,
        orgId: orgB.orgId,
        type: "integration",
        source: "local",
        draftManifest: integManifest("9.9.9"),
      });
      await seedPublishedVersion(INTEG, "1.0.0", { manifest: integManifest("1.0.0") });
    });

    it("a connect in org A cannot resolve org B's published integration", async () => {
      expect(await resolveConnectBundleVersion(INTEG, orgA.orgId)).toBeNull();
    });

    it("the owning org still resolves it (control)", async () => {
      expect(await resolveConnectBundleVersion(INTEG, orgB.orgId)).toBe("1.0.0");
    });

    it("a system package (orgId: null) still resolves for any org", async () => {
      await seedPackage({
        id: SYSTEM_INTEG,
        orgId: null,
        type: "integration",
        source: "local",
        draftManifest: integManifest("1.0.0"),
      });
      await seedPublishedVersion(SYSTEM_INTEG, "1.0.0", { manifest: integManifest("1.0.0") });

      expect(await resolveConnectBundleVersion(SYSTEM_INTEG, orgA.orgId)).toBe("1.0.0");
    });
  });

  describe("integration axis (resolveRunIntegrationVersions)", () => {
    beforeEach(async () => {
      await seedPackage({
        id: INTEG,
        orgId: orgB.orgId,
        type: "integration",
        source: "local",
        draftManifest: integManifest("9.9.9"),
      });
      await seedPackageVersion({
        packageId: INTEG,
        version: "1.0.0",
        manifest: integManifest("1.0.0"),
      });
    });

    it("a run in org A cannot resolve org B's published integration (left unseeded)", async () => {
      const cache: IntegrationManifestCache = new Map();
      const res = await resolveRunIntegrationVersions({
        orgId: orgA.orgId,
        agentManifest: agentManifest("^1.0.0"),
        manifestCache: cache,
      });

      // Cross-tenant reference resolves `not_found` — the soft path: the
      // integration is NOT frozen to org B's published version and the shared
      // manifest cache is NOT seeded with org B's manifest. (The spawn
      // resolver then drops it via its own miss-handling.)
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.versions[INTEG]).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it("the owning org still freezes the pin to its published version (control)", async () => {
      const cache: IntegrationManifestCache = new Map();
      const res = await resolveRunIntegrationVersions({
        orgId: orgB.orgId,
        agentManifest: agentManifest("^1.0.0"),
        manifestCache: cache,
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.versions[INTEG]).toEqual({ version: "1.0.0", source: "version" });
      const cached = await cache.get(INTEG);
      expect(cached?.ok).toBe(true);
    });
  });
});
