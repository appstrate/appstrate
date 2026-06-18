// SPDX-License-Identifier: Apache-2.0

/**
 * Multiple OAuth clients per integration (issue #723): a system client
 * (SYSTEM_INTEGRATION_CLIENTS) and the org's custom per-application client
 * coexist. A connection pins WHICH client minted it via `client_ref`; token
 * refresh resolves the same client's credentials by that ref. Covers:
 *   - persist stamps `client_ref` (round-trip insert/update)
 *   - refresh-context client resolution by `client_ref` (system / custom / legacy / public)
 *   - the client-listing merge + default precedence
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { encryptCredentials } from "@appstrate/connect";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import {
  saveIntegrationConnection,
  listIntegrationClients,
  resolveSystemConnectClient,
} from "../../../src/services/integration-connections.ts";
import { buildIntegrationOAuthRefreshContext } from "../../../src/services/integration-token-refresh.ts";
import {
  initSystemIntegrationClients,
  __resetSystemIntegrationClientsForTest,
  systemClientRef,
} from "../../../src/services/integration-client-registry.ts";
import type { AppScope } from "../../../src/lib/scope.ts";
import type { Actor } from "@appstrate/connect";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";

const INTEGRATION = "@appstrate/integration-gmail";
const AUTH_KEY = "google";
const SYSTEM_ID = "gmail-system";

const OAUTH2_AUTH: AfpsManifestAuth = {
  type: "oauth2",
  token_endpoint: "https://oauth2.googleapis.com/token",
} as AfpsManifestAuth;

const PUBLIC_AUTH: AfpsManifestAuth = {
  type: "oauth2",
  token_endpoint: "https://oauth2.googleapis.com/token",
  token_endpoint_auth_method: "none",
} as AfpsManifestAuth;

describe("integration multi-client", () => {
  let ctx: TestContext;
  let scope: AppScope;
  let actor: Actor;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "multiclient" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    actor = { type: "user", id: ctx.user.id };
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
    __resetSystemIntegrationClientsForTest();
  });

  afterEach(() => __resetSystemIntegrationClientsForTest());

  /** Insert a custom per-application OAuth client row directly. */
  async function seedCustomClient(clientId: string, secret: string): Promise<void> {
    await db.insert(integrationOauthClients).values({
      applicationId: ctx.defaultAppId,
      integrationId: INTEGRATION,
      authKey: AUTH_KEY,
      clientId,
      clientSecretEncrypted: encryptCredentials({ client_secret: secret }),
    });
  }

  function seedSystemClient(clientSecret = "sys-secret"): void {
    initSystemIntegrationClients([
      {
        id: SYSTEM_ID,
        integrationId: INTEGRATION,
        authKey: AUTH_KEY,
        clientId: "sys-client.apps.googleusercontent.com",
        clientSecret,
      },
    ]);
  }

  async function connect(clientRef?: string) {
    return saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: AUTH_KEY,
      accountId: "alice@example.com",
      credentials: { access_token: "tok", refresh_token: "rt" },
      identityClaims: { email: "alice@example.com" },
      actor,
      ...(clientRef ? { clientRef } : {}),
    });
  }

  async function readClientRef(connectionId: string): Promise<string | null> {
    const [row] = await db
      .select({ clientRef: integrationConnections.clientRef })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1);
    return row!.clientRef;
  }

  describe("persist stamps client_ref", () => {
    it("stores the system client_ref on insert", async () => {
      const created = await connect(systemClientRef(SYSTEM_ID));
      expect(await readClientRef(created.id)).toBe("system:gmail-system");
    });

    it("stores 'custom' on insert", async () => {
      const created = await connect("custom");
      expect(await readClientRef(created.id)).toBe("custom");
    });

    it("leaves client_ref NULL when omitted (legacy callers)", async () => {
      const created = await connect();
      expect(await readClientRef(created.id)).toBeNull();
    });

    it("re-stamps the client_ref on reconnect (update-owned)", async () => {
      const created = await connect("custom");
      expect(await readClientRef(created.id)).toBe("custom");
      // Reconnect via the same row, now minted by the system client.
      await saveIntegrationConnection(scope, {
        packageId: INTEGRATION,
        authKey: AUTH_KEY,
        accountId: "alice@example.com",
        credentials: { access_token: "tok2", refresh_token: "rt2" },
        identityClaims: { email: "alice@example.com" },
        actor,
        connectionId: created.id,
        clientRef: systemClientRef(SYSTEM_ID),
      });
      expect(await readClientRef(created.id)).toBe("system:gmail-system");
    });
  });

  describe("buildIntegrationOAuthRefreshContext resolves by client_ref", () => {
    it("uses the SYSTEM client's credentials for a system ref (no DB row needed)", async () => {
      seedSystemClient("sys-secret");
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        OAUTH2_AUTH,
        ctx.defaultAppId,
        systemClientRef(SYSTEM_ID),
      );
      expect(ctxOut).not.toBeNull();
      expect(ctxOut!.clientId).toBe("sys-client.apps.googleusercontent.com");
      expect(ctxOut!.clientSecret).toBe("sys-secret");
    });

    it("returns null when the pinned system client is no longer configured", async () => {
      // Registry has no such id (reset, not seeded).
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        OAUTH2_AUTH,
        ctx.defaultAppId,
        systemClientRef("removed-id"),
      );
      expect(ctxOut).toBeNull();
    });

    it("uses the org's CUSTOM client row for a 'custom' ref", async () => {
      await seedCustomClient("custom-client-id", "custom-secret");
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        OAUTH2_AUTH,
        ctx.defaultAppId,
        "custom",
      );
      expect(ctxOut).not.toBeNull();
      expect(ctxOut!.clientId).toBe("custom-client-id");
      expect(ctxOut!.clientSecret).toBe("custom-secret");
    });

    it("resolves a NULL (legacy) ref via the custom client row", async () => {
      await seedCustomClient("legacy-client-id", "legacy-secret");
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        OAUTH2_AUTH,
        ctx.defaultAppId,
        null,
      );
      expect(ctxOut).not.toBeNull();
      expect(ctxOut!.clientId).toBe("legacy-client-id");
    });

    it("never exposes a secret for a public system client (auth_method=none)", async () => {
      seedSystemClient("should-be-ignored");
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        PUBLIC_AUTH,
        ctx.defaultAppId,
        systemClientRef(SYSTEM_ID),
      );
      expect(ctxOut).not.toBeNull();
      expect(ctxOut!.clientSecret).toBe("");
    });

    it("returns null for a custom ref with no registered client", async () => {
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        OAUTH2_AUTH,
        ctx.defaultAppId,
        "custom",
      );
      expect(ctxOut).toBeNull();
    });
  });

  describe("round-trip: connect with a system client → refresh resolves the same client", () => {
    it("pins on connect and resolves on refresh", async () => {
      seedSystemClient("rt-secret");
      const created = await connect(systemClientRef(SYSTEM_ID));
      const pinned = await readClientRef(created.id);
      expect(pinned).toBe("system:gmail-system");
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        OAUTH2_AUTH,
        ctx.defaultAppId,
        pinned,
      );
      expect(ctxOut!.clientSecret).toBe("rt-secret");
    });
  });

  describe("resolveSystemConnectClient", () => {
    it("returns the default system client when no ref is given", () => {
      seedSystemClient();
      const resolved = resolveSystemConnectClient(INTEGRATION, AUTH_KEY);
      expect(resolved).not.toBeNull();
      expect(resolved!.clientRef).toBe("system:gmail-system");
      expect(resolved!.clientId).toBe("sys-client.apps.googleusercontent.com");
    });

    it("returns the exact system client for a matching ref", () => {
      seedSystemClient();
      const resolved = resolveSystemConnectClient(
        INTEGRATION,
        AUTH_KEY,
        systemClientRef(SYSTEM_ID),
      );
      expect(resolved!.clientRef).toBe("system:gmail-system");
    });

    it("rejects a system ref that does not serve this (integration, authKey)", () => {
      seedSystemClient();
      expect(
        resolveSystemConnectClient("@other/x", AUTH_KEY, systemClientRef(SYSTEM_ID)),
      ).toBeNull();
      expect(
        resolveSystemConnectClient(INTEGRATION, "other", systemClientRef(SYSTEM_ID)),
      ).toBeNull();
    });

    it("returns null when no system client is configured", () => {
      expect(resolveSystemConnectClient(INTEGRATION, AUTH_KEY)).toBeNull();
    });
  });

  describe("listIntegrationClients", () => {
    it("lists only the system client when no custom client is registered", async () => {
      seedSystemClient();
      const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
      expect(clients).toHaveLength(1);
      expect(clients[0]).toMatchObject({
        client_ref: "system:gmail-system",
        source: "built-in",
        is_default: true,
      });
    });

    it("lists the custom client as default when both exist (BYO-app wins)", async () => {
      seedSystemClient();
      await seedCustomClient("org-client", "org-secret");
      const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
      expect(clients).toHaveLength(2);
      const custom = clients.find((c) => c.source === "custom");
      const system = clients.find((c) => c.source === "built-in");
      expect(custom).toMatchObject({
        client_ref: "custom",
        is_default: true,
        client_id: "org-client",
      });
      expect(system).toMatchObject({ client_ref: "system:gmail-system", is_default: false });
    });

    it("returns an empty list when neither system nor custom client exists", async () => {
      const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
      expect(clients).toEqual([]);
    });

    it("never includes a client secret", async () => {
      seedSystemClient();
      await seedCustomClient("org-client", "org-secret");
      const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
      for (const c of clients) {
        expect(Object.keys(c)).not.toContain("client_secret");
        expect(Object.keys(c)).not.toContain("clientSecret");
      }
    });
  });
});
