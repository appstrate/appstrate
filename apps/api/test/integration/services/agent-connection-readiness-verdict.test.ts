// SPDX-License-Identifier: Apache-2.0

/**
 * The readiness verdict speaks the resolver's vocabulary: `source` (the layer
 * that bound the set, or whose set failed) and `error_code` (the 409 code).
 * One case per verdict family, so a layer the service re-derived instead of
 * relaying would show up here as a wrong `source`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  integrationConnections,
  integrationOrgDefaults,
  integrationPins,
} from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { resolveAgentConnectionReadiness } from "../../../src/services/integration-pins-service.ts";
import { activatePackage, deactivatePackage } from "../../../src/services/space-packages.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackage } from "../../helpers/seed.ts";
import { seedShares } from "../../helpers/connection-shares.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const AGENT = "@verdictorg/agent";
const INTEG = "@verdictorg/svc";
const MISSING = "@verdictorg/missing";

const apiKeyAuth = {
  type: "api_key" as const,
  authorizedUris: ["https://api.example.com/**"],
  credentialFields: ["api_key"],
  delivery: httpHeaderDelivery({ name: "Authorization", prefix: "Bearer ", field: "api_key" }),
};

describe("resolveAgentConnectionReadiness — { source, error_code } per verdict family", () => {
  let ctx: TestContext;
  let scope: { orgId: string; spaceId: string };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "verdictorg" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: INTEG,
        serverName: "@verdictorg/svc-server",
        version: "1.0.0",
        auths: { primary: apiKeyAuth, backup: apiKeyAuth },
        tools_policy: { search: {} },
      }),
    });
    await activatePackage(scope, INTEG);
  });

  async function seedAgentDeclaring(config: Record<string, unknown>, extra: string[] = []) {
    const deps: Record<string, string> = { [INTEG]: "^1.0.0" };
    for (const id of extra) deps[id] = "^1.0.0";
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.2",
        display_name: "Verdict Agent",
        dependencies: { integrations: deps },
        integrations_configuration: { [INTEG]: config },
      },
    });
    await activatePackage(scope, AGENT);
  }

  let seq = 0;
  async function seedConnection(over: { authKey?: string; dead?: boolean } = {}) {
    seq += 1;
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEG,
        authKey: over.authKey ?? "primary",
        accountId: `acct-${seq}`,
        orgId: ctx.orgId,
        spaceId: null,
        originSpaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        endUserId: null,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
        scopesGranted: [],
        needsReconnection: over.dead ?? false,
        label: `conn-${seq}`,
      })
      .returning({ id: integrationConnections.id });
    await seedShares(row!.id, [ctx.defaultSpaceId]);
    return row!.id;
  }

  async function pin(connectionIds: string[], userId: string | null) {
    await db.insert(integrationPins).values({
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT,
      integrationId: INTEG,
      userId,
      connectionIds,
    });
  }

  async function orgDefault(connectionIds: string[], enforce: boolean) {
    await db.insert(integrationOrgDefaults).values({
      spaceId: ctx.defaultSpaceId,
      integrationId: INTEG,
      connectionIds,
      enforce,
    });
  }

  async function entryOf(integrationId = INTEG) {
    const readiness = await resolveAgentConnectionReadiness({
      scope,
      agentPackageId: AGENT,
      principal: { kind: "person", actor: { type: "user", id: ctx.user.id } },
      canConnect: true,
      canConfigureIntegrations: true,
      version: "draft",
    });
    return readiness.integrations.find((i) => i.integration_package_id === integrationId)!;
  }

  async function verdictOf(integrationId = INTEG) {
    return (await entryOf(integrationId)).resolution;
  }

  const TOOLS = { tools: ["search"] };
  const REQUIRED = { ...TOOLS, required: true };

  describe("bound — `error_code` null, `source` the layer that bound", () => {
    it("the actor's single own connection → fallback_auto", async () => {
      await seedAgentDeclaring(TOOLS);
      const id = await seedConnection();
      expect(await verdictOf()).toMatchObject({
        source: "fallback_auto",
        error_code: null,
        warning: null,
        resolved_connection_ids: [id],
        org_default_connection_ids: null,
      });
    });

    it("an admin pin → admin_pin", async () => {
      await seedAgentDeclaring(TOOLS);
      const id = await seedConnection();
      await pin([id], null);
      expect(await verdictOf()).toMatchObject({ source: "admin_pin", error_code: null });
    });

    it("an enforced org default → org_default_enforced", async () => {
      await seedAgentDeclaring(TOOLS);
      const id = await seedConnection();
      await orgDefault([id], true);
      expect(await verdictOf()).toMatchObject({
        source: "org_default_enforced",
        error_code: null,
        org_default_connection_ids: [id],
        org_default_enforced: true,
      });
    });

    it("the actor's member pin → member_pin", async () => {
      await seedAgentDeclaring(TOOLS);
      const id = await seedConnection();
      await seedConnection();
      await pin([id], ctx.user.id);
      expect(await verdictOf()).toMatchObject({
        source: "member_pin",
        error_code: null,
        resolved_connection_ids: [id],
      });
    });

    it("a soft org default → org_default", async () => {
      await seedAgentDeclaring(TOOLS);
      const id = await seedConnection();
      await seedConnection();
      await orgDefault([id], false);
      expect(await verdictOf()).toMatchObject({ source: "org_default", error_code: null });
    });
  });

  describe("refused — `error_code` the 409 code, `source` the failing layer or null", () => {
    it("required, nothing connected → not_connected, no layer", async () => {
      await seedAgentDeclaring(REQUIRED);
      const entry = await entryOf();
      expect(entry.required).toBe(true);
      expect(entry.run_blocking).toBe(true);
      expect(entry.resolution).toMatchObject({ source: null, error_code: "not_connected" });
    });

    it("required, pinned to none → required_integration_unbound", async () => {
      await seedAgentDeclaring(REQUIRED);
      await seedConnection();
      await pin([], null);
      const entry = await entryOf();
      expect(entry.run_blocking).toBe(true);
      expect(entry.resolution).toMatchObject({
        error_code: "required_integration_unbound",
        resolved_connection_ids: [],
        admin_pinned_connection_ids: [],
      });
    });

    it("two own connections → must_choose_connection, no layer", async () => {
      await seedAgentDeclaring(TOOLS);
      await seedConnection();
      await seedConnection();
      expect(await verdictOf()).toMatchObject({
        source: null,
        error_code: "must_choose_connection",
        resolved_connection_ids: [],
      });
    });

    it("the fallback's dead connection → needs_reconnection on fallback_auto, the set still named", async () => {
      await seedAgentDeclaring(TOOLS);
      const id = await seedConnection({ dead: true });
      expect(await verdictOf()).toMatchObject({
        source: "fallback_auto",
        error_code: "needs_reconnection",
        resolved_connection_ids: [id],
      });
    });

    it("a member pin naming a gone connection → pinned_connection_unavailable on member_pin", async () => {
      await seedAgentDeclaring(TOOLS);
      await seedConnection();
      await pin([crypto.randomUUID()], ctx.user.id);
      expect(await verdictOf()).toMatchObject({
        source: "member_pin",
        error_code: "pinned_connection_unavailable",
      });
    });

    it("an enforced default naming a gone connection → pinned_connection_unavailable on org_default_enforced", async () => {
      await seedAgentDeclaring(TOOLS);
      await orgDefault([crypto.randomUUID()], true);
      expect(await verdictOf()).toMatchObject({
        source: "org_default_enforced",
        error_code: "pinned_connection_unavailable",
      });
    });

    it("required, the dep pins an auth no connection is on → auth_key_mismatch, no layer", async () => {
      await seedAgentDeclaring({ ...REQUIRED, auth_key: "backup" });
      await seedConnection({ authKey: "primary" });
      // The picker offers the resolver's candidates: none on the pinned auth.
      expect(await verdictOf()).toMatchObject({
        source: null,
        error_code: "auth_key_mismatch",
        candidates: [],
      });
    });
  });

  // Absence degrades: no `error_code`, no layer, no set — and the run is not blocked.
  // `warning` is the launch's item: the code the required twin raises, or `integration_unbound`.
  describe("unbound — optional, `error_code` null, `warning` the reason", () => {
    it("nothing connected", async () => {
      await seedAgentDeclaring(TOOLS);
      const entry = await entryOf();
      expect(entry.required).toBe(false);
      expect(entry.run_blocking).toBe(false);
      expect(entry.resolution).toMatchObject({
        source: null,
        error_code: null,
        warning: { field: `integrations.${INTEG}`, code: "not_connected" },
        resolved_connection_ids: [],
        admin_pinned_connection_ids: null,
        member_pinned_connection_ids: null,
      });
    });

    it("only connections on another auth than the dep's", async () => {
      await seedAgentDeclaring({ ...TOOLS, auth_key: "backup" });
      await seedConnection({ authKey: "primary" });
      const entry = await entryOf();
      expect(entry.run_blocking).toBe(false);
      // Not « not connected »: the actor has a connection, on the wrong auth.
      expect(entry.resolution).toMatchObject({
        error_code: null,
        warning: {
          code: "auth_key_mismatch",
          required_auth_key: "backup",
          available_auth_keys: ["primary"],
        },
        resolved_connection_ids: [],
      });
    });

    it("an admin pin to none wins over a connection the fallback would bind", async () => {
      await seedAgentDeclaring(TOOLS);
      await seedConnection();
      await pin([], null);
      const entry = await entryOf();
      expect(entry.run_blocking).toBe(false);
      expect(entry.resolution).toMatchObject({
        source: null,
        error_code: null,
        warning: { code: "integration_unbound", source: "admin_pin" },
        resolved_connection_ids: [],
        admin_pinned_connection_ids: [],
        member_pinned_connection_ids: null,
      });
    });

    it("a member pin to none is reported as [] — not as no pin", async () => {
      await seedAgentDeclaring(TOOLS);
      await seedConnection();
      await pin([], ctx.user.id);
      expect(await verdictOf()).toMatchObject({
        error_code: null,
        warning: { code: "integration_unbound", source: "member_pin" },
        resolved_connection_ids: [],
        admin_pinned_connection_ids: null,
        member_pinned_connection_ids: [],
      });
    });

    it("switched off in the space → integration_not_active, though a connection would bind", async () => {
      await seedAgentDeclaring(TOOLS);
      await seedConnection();
      await deactivatePackage(scope, INTEG);
      const entry = await entryOf();
      expect(entry.run_blocking).toBe(false);
      expect(entry.resolution).toMatchObject({
        source: null,
        error_code: null,
        warning: { code: "integration_not_active" },
        resolved_connection_ids: [],
      });
    });
  });

  it("no verdict — a declared integration whose manifest cannot load → both null", async () => {
    await seedAgentDeclaring(TOOLS, [MISSING]);
    expect(await verdictOf(MISSING)).toMatchObject({
      source: null,
      error_code: null,
      resolved_connection_ids: [],
      candidates: [],
    });
  });
});
