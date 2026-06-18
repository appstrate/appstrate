// SPDX-License-Identifier: Apache-2.0

/**
 * Multiple OAuth clients per integration (issue #723): a system client
 * (SYSTEM_INTEGRATION_CLIENTS) and the org's custom per-application client
 * coexist. A connection pins WHICH client minted it via `client_ref` — a flat
 * client id (system env id or `integration_oauth_clients.id`); token refresh
 * resolves the same client's credentials by that id (system-first then DB-by-id,
 * mirroring the model-provider credential pattern). Covers:
 *   - persist stamps `client_ref` (round-trip insert/update)
 *   - `resolveIntegrationClientById` (system / custom-by-id / cross-scope / public)
 *   - refresh-context resolution by `client_ref`
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
  resolveIntegrationClientById,
} from "../../../src/services/integration-connections.ts";
import { buildIntegrationOAuthRefreshContext } from "../../../src/services/integration-token-refresh.ts";
import {
  initSystemIntegrationClients,
  __resetSystemIntegrationClientsForTest,
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

  /** Insert a custom per-application OAuth client row directly; return its id. */
  async function seedCustomClient(clientId: string, secret: string): Promise<string> {
    const [row] = await db
      .insert(integrationOauthClients)
      .values({
        applicationId: ctx.defaultAppId,
        integrationId: INTEGRATION,
        authKey: AUTH_KEY,
        clientId,
        clientSecretEncrypted: encryptCredentials({ client_secret: secret }),
      })
      .returning({ id: integrationOauthClients.id });
    return row!.id;
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
    it("stores the system client id on insert", async () => {
      const created = await connect(SYSTEM_ID);
      expect(await readClientRef(created.id)).toBe("gmail-system");
    });

    it("stores the custom client id on insert", async () => {
      const customId = await seedCustomClient("org-client", "org-secret");
      const created = await connect(customId);
      expect(await readClientRef(created.id)).toBe(customId);
    });

    it("leaves client_ref NULL when omitted (non-oauth2 callers)", async () => {
      const created = await connect();
      expect(await readClientRef(created.id)).toBeNull();
    });

    it("re-stamps the client_ref on reconnect (update-owned)", async () => {
      const customId = await seedCustomClient("org-client", "org-secret");
      const created = await connect(customId);
      expect(await readClientRef(created.id)).toBe(customId);
      // Reconnect via the same row, now minted by the system client.
      await saveIntegrationConnection(scope, {
        packageId: INTEGRATION,
        authKey: AUTH_KEY,
        accountId: "alice@example.com",
        credentials: { access_token: "tok2", refresh_token: "rt2" },
        identityClaims: { email: "alice@example.com" },
        actor,
        connectionId: created.id,
        clientRef: SYSTEM_ID,
      });
      expect(await readClientRef(created.id)).toBe("gmail-system");
    });
  });

  describe("resolveIntegrationClientById", () => {
    it("resolves the SYSTEM client by id (no DB row needed)", async () => {
      seedSystemClient("sys-secret");
      const c = await resolveIntegrationClientById(
        SYSTEM_ID,
        ctx.defaultAppId,
        INTEGRATION,
        AUTH_KEY,
        undefined,
      );
      expect(c).toEqual({
        clientId: "sys-client.apps.googleusercontent.com",
        clientSecret: "sys-secret",
      });
    });

    it("resolves the org's CUSTOM client by id (scoped)", async () => {
      const customId = await seedCustomClient("custom-client-id", "custom-secret");
      const c = await resolveIntegrationClientById(
        customId,
        ctx.defaultAppId,
        INTEGRATION,
        AUTH_KEY,
        undefined,
      );
      expect(c).toEqual({ clientId: "custom-client-id", clientSecret: "custom-secret" });
    });

    it("does NOT resolve a custom id belonging to another application (escalation guard)", async () => {
      const customId = await seedCustomClient("custom-client-id", "custom-secret");
      const c = await resolveIntegrationClientById(
        customId,
        "app_someone_else",
        INTEGRATION,
        AUTH_KEY,
        undefined,
      );
      expect(c).toBeNull();
    });

    it("does NOT resolve a custom id for a different integration (escalation guard)", async () => {
      const customId = await seedCustomClient("custom-client-id", "custom-secret");
      const c = await resolveIntegrationClientById(
        customId,
        ctx.defaultAppId,
        "@other/integration",
        AUTH_KEY,
        undefined,
      );
      expect(c).toBeNull();
    });

    it("returns null when the id resolves to neither a system nor a custom client", async () => {
      const c = await resolveIntegrationClientById(
        "unknown-id",
        ctx.defaultAppId,
        INTEGRATION,
        AUTH_KEY,
        undefined,
      );
      expect(c).toBeNull();
    });

    it("returns null when a pinned system id was remapped to another integration", async () => {
      initSystemIntegrationClients([
        {
          id: SYSTEM_ID,
          integrationId: "@other/integration",
          authKey: AUTH_KEY,
          clientId: "other-client",
          clientSecret: "other-secret",
        },
      ]);
      const c = await resolveIntegrationClientById(
        SYSTEM_ID,
        ctx.defaultAppId,
        INTEGRATION,
        AUTH_KEY,
        undefined,
      );
      expect(c).toBeNull();
    });

    it("drops the secret for a public client (auth_method=none) — system", async () => {
      seedSystemClient("should-be-ignored");
      const c = await resolveIntegrationClientById(
        SYSTEM_ID,
        ctx.defaultAppId,
        INTEGRATION,
        AUTH_KEY,
        "none",
      );
      expect(c).toEqual({
        clientId: "sys-client.apps.googleusercontent.com",
        clientSecret: "",
      });
    });

    it("drops the secret for a public client (auth_method=none) — custom (no decrypt)", async () => {
      const customId = await seedCustomClient("custom-client-id", "custom-secret");
      const c = await resolveIntegrationClientById(
        customId,
        ctx.defaultAppId,
        INTEGRATION,
        AUTH_KEY,
        "none",
      );
      expect(c).toEqual({ clientId: "custom-client-id", clientSecret: "" });
    });
  });

  describe("buildIntegrationOAuthRefreshContext resolves by client_ref", () => {
    it("uses the SYSTEM client's credentials for a system id", async () => {
      seedSystemClient("sys-secret");
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        OAUTH2_AUTH,
        ctx.defaultAppId,
        SYSTEM_ID,
      );
      expect(ctxOut).not.toBeNull();
      expect(ctxOut!.clientId).toBe("sys-client.apps.googleusercontent.com");
      expect(ctxOut!.clientSecret).toBe("sys-secret");
    });

    it("uses the org's CUSTOM client for a custom id", async () => {
      const customId = await seedCustomClient("custom-client-id", "custom-secret");
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        OAUTH2_AUTH,
        ctx.defaultAppId,
        customId,
      );
      expect(ctxOut).not.toBeNull();
      expect(ctxOut!.clientId).toBe("custom-client-id");
      expect(ctxOut!.clientSecret).toBe("custom-secret");
    });

    it("returns null when the pinned client id is no longer configured", async () => {
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        OAUTH2_AUTH,
        ctx.defaultAppId,
        "removed-id",
      );
      expect(ctxOut).toBeNull();
    });

    it("returns null for a NULL client_ref (oauth2 invariant — must never resolve a client)", async () => {
      // A non-oauth2 row should never reach this path; if it does, refresh skips
      // rather than guessing a client. A custom row present must NOT be picked up.
      await seedCustomClient("should-not-be-used", "secret");
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        OAUTH2_AUTH,
        ctx.defaultAppId,
        null,
      );
      expect(ctxOut).toBeNull();
    });

    it("never exposes a secret for a public system client (auth_method=none)", async () => {
      seedSystemClient("should-be-ignored");
      const ctxOut = await buildIntegrationOAuthRefreshContext(
        INTEGRATION,
        AUTH_KEY,
        PUBLIC_AUTH,
        ctx.defaultAppId,
        SYSTEM_ID,
      );
      expect(ctxOut).not.toBeNull();
      expect(ctxOut!.clientSecret).toBe("");
    });
  });

  describe("round-trip: connect with a system client → refresh resolves the same client", () => {
    it("pins on connect and resolves on refresh", async () => {
      seedSystemClient("rt-secret");
      const created = await connect(SYSTEM_ID);
      const pinned = await readClientRef(created.id);
      expect(pinned).toBe("gmail-system");
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

  describe("listIntegrationClients", () => {
    it("lists only the system client when no custom client is registered", async () => {
      seedSystemClient();
      const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
      expect(clients).toHaveLength(1);
      expect(clients[0]).toMatchObject({
        client_ref: "gmail-system",
        source: "built-in",
        is_default: true,
      });
    });

    it("lists the custom client as default when both exist (BYO-app wins)", async () => {
      seedSystemClient();
      const customId = await seedCustomClient("org-client", "org-secret");
      const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
      expect(clients).toHaveLength(2);
      const custom = clients.find((c) => c.source === "custom");
      const system = clients.find((c) => c.source === "built-in");
      expect(custom).toMatchObject({
        client_ref: customId,
        is_default: true,
        client_id: "org-client",
      });
      expect(system).toMatchObject({ client_ref: "gmail-system", is_default: false });
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
