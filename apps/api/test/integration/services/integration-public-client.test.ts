// SPDX-License-Identifier: Apache-2.0

/**
 * "Public client" as a stored declaration rather than an inference.
 *
 * It used to be derived from an empty `client_secret`: an inference asserted
 * in three comments and enforced nowhere, which paired a manifest-declared
 * `client_secret_post` with a blank secret and put `client_secret=` on the
 * wire. Dropbox answered `invalid_client`; Airtable tolerated the equivalent
 * empty Basic header. `integration_oauth_clients.token_endpoint_auth_method`
 * now records what the admin declared, and the resolvers return that method
 * TOGETHER with the credentials it belongs to, so nothing downstream re-derives
 * it.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { encryptCredentials } from "@appstrate/connect";
import { integrationOauthClients } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import {
  createIntegrationOAuthClient,
  updateIntegrationOAuthClient,
  resolveIntegrationClientById,
  encodeClientAuthForStorage,
  listIntegrationClients,
} from "../../../src/services/integration-connections.ts";
import { __resetSystemIntegrationsForTest } from "../../../src/services/integration-client-registry.ts";
import type { AppScope } from "../../../src/lib/scope.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

const INTEGRATION = "@myorg/probe";
const AUTH_KEY = "primary";

const MANIFEST = {
  type: "integration",
  schema_version: "0.1",
  name: INTEGRATION,
  version: "1.0.0",
  display_name: "Probe",
  source: { kind: "none" },
  auths: {
    [AUTH_KEY]: {
      type: "oauth2",
      authorization_endpoint: "https://idp.example.com/authorize",
      token_endpoint: "https://idp.example.com/token",
      token_endpoint_auth_method: "client_secret_post",
      default_scopes: ["read"],
      authorized_uris: ["https://api.example.com/**"],
      delivery: { http: { in: "header", name: "Authorization", value: "{$credential.token}" } },
    },
  },
} as unknown as IntegrationManifest;

describe("public OAuth client is declared, not inferred", () => {
  let ctx: TestContext;
  let scope: AppScope;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: MANIFEST,
    });
    __resetSystemIntegrationsForTest();
  });

  afterEach(() => __resetSystemIntegrationsForTest());

  async function storedRow(id: string) {
    const [row] = await db
      .select()
      .from(integrationOauthClients)
      .where(eq(integrationOauthClients.id, id));
    return row!;
  }

  describe("encodeClientAuthForStorage writes both halves together", () => {
    // A blank secret with NO method declared is the RFC 7591 §3.2.1
    // registration answer — an authorization server that returns no
    // `client_secret` registered a PUBLIC client. That is the shape auto-DCR
    // hands the service directly; the admin route can no longer produce it,
    // because `oauthClientCreateSchema` refuses a missing secret unless
    // `"none"` is declared.
    it("records a blank secret with no declared method as a public client (DCR)", () => {
      expect(encodeClientAuthForStorage({ clientSecret: "" })).toEqual({
        tokenEndpointAuthMethod: "none",
        clientSecretEncrypted: "",
      });
    });

    // The inference this whole file exists to remove, in its last hiding place:
    // `secret.length === 0` used to WIN over the caller's declaration, so a
    // caller stating `client_secret_basic` and supplying no secret got a public
    // client written to the row — and a token endpoint answering HTTP 400 much
    // later. Defence in depth for the callers that bypass the route schema.
    it("throws when a secret-based method is declared with an empty secret", () => {
      expect(() =>
        encodeClientAuthForStorage({
          clientSecret: "",
          tokenEndpointAuthMethod: "client_secret_basic",
        }),
      ).toThrow(/requires a client_secret/);
    });

    it("keeps a confidential client undeclared so the manifest decides", () => {
      const out = encodeClientAuthForStorage({ clientSecret: "shh" })!;
      expect(out.tokenEndpointAuthMethod).toBeNull();
      expect(out.clientSecretEncrypted.length).toBeGreaterThan(0);
    });

    // The distinction that stops a rotation from destroying a credential: an
    // ABSENT secret field is not the same statement as an empty one. Rotation
    // submits an empty input when the admin only meant to change the redirect
    // URI, and that keystroke-free edit used to clear the secret AND flip the
    // client public.
    it("preserves the stored pair when no secret field was submitted", () => {
      expect(encodeClientAuthForStorage({})).toBeNull();
    });

    it("still declares public when 'none' is explicit and no secret is sent", () => {
      expect(encodeClientAuthForStorage({ tokenEndpointAuthMethod: "none" })).toEqual({
        tokenEndpointAuthMethod: "none",
        clientSecretEncrypted: "",
      });
    });
  });

  describe("createIntegrationOAuthClient", () => {
    it("stores 'none' and NO ciphertext for a blank secret", async () => {
      const client = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "cid",
        clientSecret: "",
      });
      const row = await storedRow(client.id);
      expect(row.tokenEndpointAuthMethod).toBe("none");
      expect(row.clientSecretEncrypted).toBe("");
      expect(client.has_client_secret).toBe(false);
      expect(client.token_endpoint_auth_method).toBe("none");
    });

    it("leaves a confidential client undeclared", async () => {
      const client = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "cid",
        clientSecret: "shh",
      });
      const row = await storedRow(client.id);
      expect(row.tokenEndpointAuthMethod).toBeNull();
      expect(row.clientSecretEncrypted.length).toBeGreaterThan(0);
      expect(client.token_endpoint_auth_method).toBeNull();
    });
  });

  describe("resolveIntegrationClientById returns a coherent pair", () => {
    it("a declared public client comes back as 'none' with no secret", async () => {
      const client = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "cid",
        clientSecret: "",
      });
      // The manifest says client_secret_post; the client's own declaration wins.
      const resolved = await resolveIntegrationClientById(
        client.id,
        ctx.defaultAppId,
        INTEGRATION,
        AUTH_KEY,
        "client_secret_post",
      );
      expect(resolved).toEqual({
        clientId: "cid",
        clientSecret: "",
        tokenEndpointAuthMethod: "none",
      });
    });

    it("a confidential client falls through to the manifest's method", async () => {
      const client = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "cid",
        clientSecret: "shh",
      });
      const resolved = await resolveIntegrationClientById(
        client.id,
        ctx.defaultAppId,
        INTEGRATION,
        AUTH_KEY,
        "client_secret_post",
      );
      expect(resolved).toEqual({
        clientId: "cid",
        clientSecret: "shh",
        tokenEndpointAuthMethod: "client_secret_post",
      });
    });

    // LEGACY: rows written before the column encrypted an empty secret rather
    // than declaring `none`. Delete this case together with the resolver's
    // legacy branch, once the backfill has run everywhere.
    it("a legacy row that encrypted an empty secret still resolves as public", async () => {
      const [row] = await db
        .insert(integrationOauthClients)
        .values({
          applicationId: ctx.defaultAppId,
          integrationId: INTEGRATION,
          authKey: AUTH_KEY,
          clientId: "legacy-cid",
          clientSecretEncrypted: encryptCredentials({ client_secret: "" }),
          isDefault: true,
        })
        .returning({ id: integrationOauthClients.id });
      const resolved = await resolveIntegrationClientById(
        row!.id,
        ctx.defaultAppId,
        INTEGRATION,
        AUTH_KEY,
        "client_secret_post",
      );
      expect(resolved).toEqual({
        clientId: "legacy-cid",
        clientSecret: "",
        tokenEndpointAuthMethod: "none",
      });
    });
  });

  describe("rotation never destroys a credential it was not asked to change", () => {
    // Found by an adversarial review: the rotate form initialises the secret
    // input EMPTY, so an admin changing only the redirect URI submitted `""`.
    // Read as "declare public", that cleared the stored secret and flipped a
    // confidential client to public — silently.
    it("preserves the stored secret when the field is not submitted", async () => {
      const created = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "cid",
        clientSecret: "shh",
      });
      const rotated = await updateIntegrationOAuthClient(scope, created.id, {
        clientId: "cid",
        redirectUri: "https://example.com/cb",
      });
      expect(rotated.has_client_secret).toBe(true);
      expect(rotated.token_endpoint_auth_method).toBeNull();
      const row = await storedRow(created.id);
      expect(row.clientSecretEncrypted.length).toBeGreaterThan(0);
      expect(row.redirectUri).toBe("https://example.com/cb");
    });

    it("still lets an explicit public declaration clear it", async () => {
      const created = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "cid",
        clientSecret: "shh",
      });
      const rotated = await updateIntegrationOAuthClient(scope, created.id, {
        clientId: "cid",
        tokenEndpointAuthMethod: "none",
      });
      expect(rotated.has_client_secret).toBe(false);
      expect(rotated.token_endpoint_auth_method).toBe("none");
      expect((await storedRow(created.id)).clientSecretEncrypted).toBe("");
    });
  });

  // Also from the review: `projectClientWithSecret` swallowed a decryption
  // failure into an empty secret, which the legacy fallback then reported as a
  // public client — handing the connect flow an empty credential for a row
  // that actually holds a secret nobody can read.
  it("never reports an unreadable ciphertext as a public client", async () => {
    const [row] = await db
      .insert(integrationOauthClients)
      .values({
        applicationId: ctx.defaultAppId,
        integrationId: INTEGRATION,
        authKey: AUTH_KEY,
        clientId: "corrupt-cid",
        // Structurally a ciphertext (satisfies the biconditional CHECK) but
        // not one this key can open.
        clientSecretEncrypted: "v1.notarealkid.bm90LWEtcmVhbC1jaXBoZXJ0ZXh0",
        isDefault: true,
      })
      .returning({ id: integrationOauthClients.id });
    const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
    const custom = clients.find((c) => c.client_ref === row!.id);
    expect(custom?.token_endpoint_auth_method).toBeNull();
    expect(custom?.has_client_secret).toBe(true);
  });

  it("surfaces the declaration in the client list the UI reads", async () => {
    await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
      clientId: "cid",
      clientSecret: "",
    });
    const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
    const custom = clients.find((c) => c.source === "custom");
    expect(custom?.token_endpoint_auth_method).toBe("none");
    // The checkbox reads the declaration; `has_client_secret` alone could not
    // distinguish this from a confidential client whose secret was not re-typed.
    expect(custom?.has_client_secret).toBe(false);
  });
});
