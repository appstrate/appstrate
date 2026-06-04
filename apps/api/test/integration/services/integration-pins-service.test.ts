// SPDX-License-Identifier: Apache-2.0

/**
 * Service-level tests for the DB-querying access/ownership logic in
 * integration-pins-service. The resolver's cascade is unit-tested in
 * integration-connection-resolver with hand-built candidate arrays; this
 * file exercises the real Drizzle queries those candidates come from:
 *
 *   - validatePinTarget — cross-app / cross-integration / sharing /
 *     ownership rejection (the gate every pin write passes through)
 *   - listAccessibleConnections — own ∪ sharedWithOrg, deduped, scoped
 *     to (application, integration), filtered by actor
 *   - loadConnectionOwnership — owner projection used by RBAC checks
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedApplication } from "../../helpers/seed.ts";
import { integrationConnections } from "@appstrate/db/schema";
import type { AppScope } from "../../../src/lib/scope.ts";
import {
  validatePinTarget,
  listAccessibleConnections,
  loadConnectionOwnership,
} from "../../../src/services/integration-pins-service.ts";

const INTEGRATION = "@official/gmail";
const OTHER_INTEGRATION = "@official/clickup";

async function seedConnection(opts: {
  integrationId?: string;
  applicationId: string;
  authKey?: string;
  accountId?: string;
  userId?: string | null;
  endUserId?: string | null;
  sharedWithOrg?: boolean;
  label?: string;
}): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: opts.integrationId ?? INTEGRATION,
      authKey: opts.authKey ?? "google",
      accountId: opts.accountId ?? `acct-${crypto.randomUUID().slice(0, 8)}`,
      applicationId: opts.applicationId,
      userId: opts.userId ?? null,
      endUserId: opts.endUserId ?? null,
      credentialsEncrypted: "x",
      scopesGranted: ["openid", "email"],
      sharedWithOrg: opts.sharedWithOrg ?? false,
      label: opts.label ?? null,
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

describe("integration-pins-service — DB access/ownership", () => {
  let ctx: TestContext;
  let scope: AppScope;
  let memberId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pinsorg" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
    await seedPackage({
      id: OTHER_INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
    });
    const member = await createTestUser();
    memberId = member.id;
    await addOrgMember(ctx.orgId, member.id);
  });

  describe("validatePinTarget", () => {
    it("throws notFound for an unknown connection id", async () => {
      await expect(validatePinTarget(scope, INTEGRATION, crypto.randomUUID(), {})).rejects.toThrow(
        /not found/i,
      );
    });

    it("rejects a connection from a different application", async () => {
      const otherApp = await seedApplication({ orgId: ctx.orgId, name: "Other" });
      const id = await seedConnection({ applicationId: otherApp.id, userId: ctx.user.id });
      await expect(validatePinTarget(scope, INTEGRATION, id, {})).rejects.toThrow(
        /different application/i,
      );
    });

    it("rejects a connection belonging to a different integration", async () => {
      const id = await seedConnection({
        integrationId: OTHER_INTEGRATION,
        applicationId: scope.applicationId,
        userId: ctx.user.id,
      });
      await expect(validatePinTarget(scope, INTEGRATION, id, {})).rejects.toThrow(
        /belongs to integration/i,
      );
    });

    it("rejects a non-shared connection when requireShared is set", async () => {
      const id = await seedConnection({
        applicationId: scope.applicationId,
        userId: ctx.user.id,
        sharedWithOrg: false,
      });
      await expect(
        validatePinTarget(scope, INTEGRATION, id, { requireShared: true }),
      ).rejects.toThrow(/sharedWithOrg/i);
    });

    it("accepts a shared connection under requireShared", async () => {
      const id = await seedConnection({
        applicationId: scope.applicationId,
        userId: memberId,
        sharedWithOrg: true,
      });
      const conn = await validatePinTarget(scope, INTEGRATION, id, { requireShared: true });
      expect(conn.id).toBe(id);
    });

    it("rejects allowOwnedBy when the connection is neither owned nor shared", async () => {
      const id = await seedConnection({
        applicationId: scope.applicationId,
        userId: memberId,
        sharedWithOrg: false,
      });
      await expect(
        validatePinTarget(scope, INTEGRATION, id, { allowOwnedBy: ctx.user.id }),
      ).rejects.toThrow(/owned by you or shared/i);
    });

    it("accepts allowOwnedBy when the caller owns the connection", async () => {
      const id = await seedConnection({
        applicationId: scope.applicationId,
        userId: ctx.user.id,
      });
      const conn = await validatePinTarget(scope, INTEGRATION, id, { allowOwnedBy: ctx.user.id });
      expect(conn.id).toBe(id);
    });
  });

  describe("listAccessibleConnections", () => {
    it("returns the actor's own connections plus org-shared, deduped", async () => {
      const own = await seedConnection({ applicationId: scope.applicationId, userId: ctx.user.id });
      const sharedByMember = await seedConnection({
        applicationId: scope.applicationId,
        userId: memberId,
        sharedWithOrg: true,
      });
      // Owned AND shared by the caller — must appear exactly once.
      const ownAndShared = await seedConnection({
        applicationId: scope.applicationId,
        userId: ctx.user.id,
        sharedWithOrg: true,
      });
      // Another member's private connection — must NOT be visible.
      await seedConnection({ applicationId: scope.applicationId, userId: memberId });

      const list = await listAccessibleConnections(scope, INTEGRATION, { userId: ctx.user.id });
      const ids = list.map((c) => c.id);
      expect(ids).toContain(own);
      expect(ids).toContain(sharedByMember);
      expect(ids).toContain(ownAndShared);
      expect(ids.filter((i) => i === ownAndShared)).toHaveLength(1);
      expect(list).toHaveLength(3);
    });

    it("excludes connections from other integrations and other applications", async () => {
      const visible = await seedConnection({
        applicationId: scope.applicationId,
        userId: ctx.user.id,
      });
      await seedConnection({
        integrationId: OTHER_INTEGRATION,
        applicationId: scope.applicationId,
        userId: ctx.user.id,
      });
      const otherApp = await seedApplication({ orgId: ctx.orgId, name: "Other" });
      await seedConnection({
        applicationId: otherApp.id,
        userId: ctx.user.id,
        sharedWithOrg: true,
      });

      const list = await listAccessibleConnections(scope, INTEGRATION, { userId: ctx.user.id });
      expect(list.map((c) => c.id)).toEqual([visible]);
    });
  });

  describe("loadConnectionOwnership", () => {
    it("projects the owner columns for an existing connection", async () => {
      const id = await seedConnection({ applicationId: scope.applicationId, userId: ctx.user.id });
      const ownership = await loadConnectionOwnership(id);
      expect(ownership).toEqual({
        applicationId: scope.applicationId,
        userId: ctx.user.id,
        endUserId: null,
      });
    });

    it("returns null for an unknown connection id", async () => {
      expect(await loadConnectionOwnership(crypto.randomUUID())).toBeNull();
    });
  });
});
