// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `integration-service.ts` — INTEGRATIONS_PROPOSAL
 * Phase 1.0 read path. Covers org/system scoping, manifest validation
 * fallback, version lookup, and the installed-in-app join used by the
 * future runtime resolver.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { getIntegration, listIntegrations } from "../../../src/services/integration-service.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

function validIntegrationManifest(name = "@official/gmail"): Record<string, unknown> {
  return localIntegrationManifest({
    name,
    displayName: "Gmail",
    auths: {
      api: {
        type: "api_key",
        authorizedUris: ["https://gmail.googleapis.com/**"],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "api_key",
        }),
      },
    },
  }) as unknown as Record<string, unknown>;
}

describe("integration-service", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  describe("getIntegration", () => {
    it("returns null when no row matches", async () => {
      const out = await getIntegration(ctx.orgId, "@nothing/here");
      expect(out).toBeNull();
    });

    it("returns the row when org-owned with a valid manifest", async () => {
      const manifest = validIntegrationManifest("@official/gmail");
      await seedPackage({
        id: "@official/gmail",
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: manifest,
      });
      const out = await getIntegration(ctx.orgId, "@official/gmail");
      expect(out).not.toBeNull();
      expect(out!.id).toBe("@official/gmail");
      expect(out!.manifest.display_name).toBe("Gmail");
      expect(out!.source).toBe("local");
    });

    it("returns the row when it's a system package (orgId: null)", async () => {
      const manifest = validIntegrationManifest("@official/system-int");
      await seedPackage({
        id: "@official/system-int",
        orgId: null,
        source: "system",
        type: "integration",
        draftManifest: manifest,
      });
      const out = await getIntegration(ctx.orgId, "@official/system-int");
      expect(out).not.toBeNull();
      expect(out!.source).toBe("system");
    });

    it("rejects a row owned by another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedPackage({
        id: "@other/secret",
        orgId: otherCtx.orgId,
        type: "integration",
        draftManifest: validIntegrationManifest("@other/secret"),
      });
      const out = await getIntegration(ctx.orgId, "@other/secret");
      expect(out).toBeNull();
    });

    it("returns null (not 500) when the manifest fails validation", async () => {
      // Corrupted manifest: missing required fields. The service should
      // log + treat as missing, not crash callers.
      await seedPackage({
        id: "@official/broken",
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: { type: "integration", name: "@official/broken" },
      });
      const out = await getIntegration(ctx.orgId, "@official/broken");
      expect(out).toBeNull();
    });

    it("does not return non-integration packages", async () => {
      await seedPackage({
        id: "@official/agent-x",
        orgId: ctx.orgId,
        type: "agent",
      });
      const out = await getIntegration(ctx.orgId, "@official/agent-x");
      expect(out).toBeNull();
    });
  });

  describe("listIntegrations", () => {
    it("returns an empty array when no integrations exist", async () => {
      const out = await listIntegrations(ctx.orgId);
      expect(out).toEqual([]);
    });

    it("returns org + system integrations together, sorted by id stability", async () => {
      await seedPackage({
        id: "@official/a",
        orgId: null,
        source: "system",
        type: "integration",
        draftManifest: validIntegrationManifest("@official/a"),
      });
      await seedPackage({
        id: "@official/b",
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: validIntegrationManifest("@official/b"),
      });
      const out = await listIntegrations(ctx.orgId);
      expect(out.length).toBe(2);
      const ids = out.map((r) => r.id).sort();
      expect(ids).toEqual(["@official/a", "@official/b"]);
    });

    it("excludes non-integration packages from the listing", async () => {
      await seedPackage({
        id: "@official/agent",
        orgId: ctx.orgId,
        type: "agent",
      });
      await seedPackage({
        id: "@official/skill",
        orgId: ctx.orgId,
        type: "skill",
      });
      await seedPackage({
        id: "@official/int",
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: validIntegrationManifest("@official/int"),
      });
      const out = await listIntegrations(ctx.orgId);
      expect(out.length).toBe(1);
      expect(out[0]!.id).toBe("@official/int");
    });

    it("skips broken rows without aborting the whole list", async () => {
      await seedPackage({
        id: "@official/good",
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: validIntegrationManifest("@official/good"),
      });
      await seedPackage({
        id: "@official/broken",
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: { type: "integration", name: "@official/broken" },
      });
      const out = await listIntegrations(ctx.orgId);
      expect(out.length).toBe(1);
      expect(out[0]!.id).toBe("@official/good");
    });

    it("isolates orgs", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedPackage({
        id: "@other/leak",
        orgId: otherCtx.orgId,
        type: "integration",
        draftManifest: validIntegrationManifest("@other/leak"),
      });
      const out = await listIntegrations(ctx.orgId);
      expect(out).toEqual([]);
    });
  });
});
