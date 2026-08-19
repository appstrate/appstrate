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
import { encryptCredentials, ClientAuthInvariantError } from "@appstrate/connect";
import { integrationOauthClients } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import {
  createIntegrationOAuthClient,
  updateIntegrationOAuthClient,
  resolveIntegrationClientById,
  encodeClientAuthForStorage,
  listIntegrationClients,
  ensureIntegrationOAuthClient,
  resolveConnectClient,
} from "../../../src/services/integration-connections.ts";
import { __resetSystemIntegrationsForTest } from "../../../src/services/integration-client-registry.ts";
import type { AppScope } from "../../../src/lib/scope.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";

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

/** The manifest's auth, as `OAuth2Strategy.begin` hands it to the resolver. */
const OAUTH2_AUTH = {
  type: "oauth2",
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  token_endpoint_auth_method: "client_secret_post",
} as AfpsManifestAuth;

/**
 * The same auth declaring `token_endpoint_auth_method: "none"` — the
 * declaration that made `assertClientAuthCoherent` return early, so an
 * unreadable confidential client used to go out on the wire as a PUBLIC one.
 */
const PUBLIC_AUTH = {
  type: "oauth2",
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  token_endpoint_auth_method: "none",
} as AfpsManifestAuth;

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

  /**
   * A row exactly as it was written before `token_endpoint_auth_method`
   * existed: no declaration, and a ciphertext over an EMPTY secret. Structurally
   * `NULL` + non-empty ciphertext, so it satisfies `ioc_public_iff_no_secret` —
   * which is precisely why the CHECK cannot eliminate it and only a human
   * running the `UPDATE` the refusal prints can.
   */
  async function seedLegacyPublicRow(clientId = "legacy-cid"): Promise<string> {
    const [row] = await db
      .insert(integrationOauthClients)
      .values({
        applicationId: ctx.defaultAppId,
        integrationId: INTEGRATION,
        authKey: AUTH_KEY,
        clientId,
        clientSecretEncrypted: encryptCredentials({ client_secret: "" }),
        isDefault: true,
      })
      .returning({ id: integrationOauthClients.id });
    return row!.id;
  }

  /**
   * A row holding a secret nobody can read — structurally a ciphertext (so the
   * biconditional CHECK accepts it) but not one this key opens. A DIFFERENT
   * state from the legacy row above: it HAS a secret.
   */
  async function seedUnreadableRow(clientId = "corrupt-cid"): Promise<string> {
    const [row] = await db
      .insert(integrationOauthClients)
      .values({
        applicationId: ctx.defaultAppId,
        integrationId: INTEGRATION,
        authKey: AUTH_KEY,
        clientId,
        clientSecretEncrypted: "v1.notarealkid.bm90LWEtcmVhbC1jaXBoZXJ0ZXh0",
        isDefault: true,
      })
      .returning({ id: integrationOauthClients.id });
    return row!.id;
  }

  /**
   * The real connect-time client resolution — the same two calls
   * `OAuth2Strategy.begin` makes before it builds the authorize redirect. A
   * throw here is a failure the user never sees as a provider consent screen.
   */
  async function resolveForConnect(auth: AfpsManifestAuth = OAUTH2_AUTH) {
    const resolved = await ensureIntegrationOAuthClient(
      scope,
      INTEGRATION,
      AUTH_KEY,
      MANIFEST,
      auth,
      "https://app.example.com/callback",
    );
    return resolveConnectClient(INTEGRATION, AUTH_KEY, MANIFEST, auth, resolved);
  }

  describe("encodeClientAuthForStorage writes both halves together", () => {
    // The last inference, now closed. A blank secret with NO method declared
    // used to be read as the RFC 7591 §3.2.1 registration answer and stored as
    // public. Every production path declares the method now — the admin routes
    // refuse a missing secret unless `"none"` is sent, and auto-DCR declares
    // `"none"` itself after reading the authorization server's own
    // `token_endpoint_auth_method` — so this is a chokepoint for future direct
    // callers rather than a live path.
    //
    // Deleting the guard instead of throwing would be worse: the fall-through
    // writes a NULL method beside a ciphertext over an empty secret — a fresh
    // instance of the legacy row whose only repair is a human running an
    // `UPDATE`, which is not a state worth manufacturing more of.
    it("throws when a blank secret arrives with no declared method", () => {
      expect(() => encodeClientAuthForStorage({ clientSecret: "" })).toThrow(
        /no token_endpoint_auth_method/,
      );
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
    it("stores 'none' and NO ciphertext for a declared public client", async () => {
      const client = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "cid",
        clientSecret: "",
        tokenEndpointAuthMethod: "none",
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
        tokenEndpointAuthMethod: "none",
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

    // The inverse of the case this file used to assert. A row written before
    // the column encrypted an EMPTY secret instead of declaring `none`, and the
    // resolver re-derived `"none"` from the emptiness. That inference is the
    // one the column exists to delete, so the row is now refused by name — and
    // the message carries the repair, because nothing automatic can fix it
    // (Postgres cannot see through the ciphertext, so no migration can).
    it("refuses a legacy row that encrypted an empty secret", async () => {
      const id = await seedLegacyPublicRow();
      const attempt = resolveIntegrationClientById(
        id,
        ctx.defaultAppId,
        INTEGRATION,
        AUTH_KEY,
        "client_secret_post",
      );
      // The remedy names THIS row: an operator must be able to paste it.
      await expect(attempt).rejects.toThrow(
        new RegExp(`UPDATE integration_oauth_clients .* WHERE id = '${id}';`),
      );
      await expect(attempt).rejects.toThrow(ClientAuthInvariantError);
    });

    // The manifest declaring nothing is the WORSE half of the same state: with
    // `method === undefined`, `assertClientAuthCoherent` returns early, so the
    // exchange used to go out with an empty secret and no method at all.
    it("refuses a legacy row even when the manifest declares no method", async () => {
      const id = await seedLegacyPublicRow();
      await expect(
        resolveIntegrationClientById(id, ctx.defaultAppId, INTEGRATION, AUTH_KEY, undefined),
      ).rejects.toThrow(ClientAuthInvariantError);
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

    // The residual hole on the other side of the preserve sentinel: an ABSENT
    // secret next to an explicitly declared secret-based method is a change
    // request, not a preserve. It used to return the sentinel, skip both
    // columns and answer 200 — the admin saw success on a row that never moved.
    it("applies a declared method against the stored secret when none is re-typed", async () => {
      const created = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "cid",
        clientSecret: "shh",
      });
      const before = (await storedRow(created.id)).clientSecretEncrypted;
      const updated = await updateIntegrationOAuthClient(scope, created.id, {
        clientId: "cid",
        tokenEndpointAuthMethod: "client_secret_basic",
      });
      expect(updated.token_endpoint_auth_method).toBe("client_secret_basic");
      expect(updated.has_client_secret).toBe(true);
      const row = await storedRow(created.id);
      expect(row.tokenEndpointAuthMethod).toBe("client_secret_basic");
      // Changing the TRANSPORT must not re-encrypt or disturb the credential.
      expect(row.clientSecretEncrypted).toBe(before);
    });

    it("refuses to make a public client confidential without a secret", async () => {
      const created = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "cid",
        clientSecret: "",
        tokenEndpointAuthMethod: "none",
      });
      await expect(
        updateIntegrationOAuthClient(scope, created.id, {
          clientId: "cid",
          tokenEndpointAuthMethod: "client_secret_post",
        }),
      ).rejects.toThrow(/Send the client_secret together with the method/);
      // Refused, not half-applied.
      const row = await storedRow(created.id);
      expect(row.tokenEndpointAuthMethod).toBe("none");
      expect(row.clientSecretEncrypted).toBe("");
    });
  });

  /**
   * A client that cannot produce a correct token request is refused at
   * RESOLUTION, before `OAuth2Strategy.begin` builds the authorize redirect —
   * not after the user has consented at the provider. The admin list keeps
   * rendering the same row, because the admin has to see it to fix it.
   */
  describe("the connect path refuses an unusable client before any redirect", () => {
    it("refuses an unreadable ciphertext, naming the key and the re-registration", async () => {
      const id = await seedUnreadableRow();
      await expect(resolveForConnect()).rejects.toThrow(/cannot be decrypted/);
      await expect(resolveForConnect()).rejects.toThrow(/CONNECTION_ENCRYPTION_KEY/);
      await expect(resolveForConnect()).rejects.toThrow(/re-register the client/);
      // …while the admin list still renders it, marked.
      const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
      const custom = clients.find((c) => c.client_ref === id);
      expect(custom?.has_client_secret).toBe(true);
      expect(custom?.token_endpoint_auth_method).toBeNull();
    });

    // The silent downgrade: with the manifest declaring `"none"`,
    // `assertClientAuthCoherent` returned early and the exchange went out as a
    // PUBLIC client — a confidential client substituted, which is the exact
    // thing `token_endpoint_auth_method` was added to make impossible.
    it("refuses an unreadable ciphertext even when the manifest declares 'none'", async () => {
      await seedUnreadableRow();
      await expect(resolveForConnect(PUBLIC_AUTH)).rejects.toThrow(/cannot be decrypted/);
    });

    // Both exits belong in the message. Canonicalising a row that is actually
    // confidential would publish it, so the refusal offers the UPDATE *and* the
    // re-registration and lets the operator pick — the same pair the
    // unreadable-ciphertext refusal above offers.
    it("refuses a legacy row, naming the SQL repair and the re-registration", async () => {
      const id = await seedLegacyPublicRow();
      await expect(resolveForConnect()).rejects.toThrow(
        new RegExp(
          `UPDATE integration_oauth_clients SET token_endpoint_auth_method = 'none', ` +
            `client_secret_encrypted = '' WHERE id = '${id}';`,
        ),
      );
      await expect(resolveForConnect()).rejects.toThrow(/re-register it with its secret/);
      const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
      const custom = clients.find((c) => c.client_ref === id);
      // The list's marker for the state: no declaration AND no readable secret.
      expect(custom?.has_client_secret).toBe(false);
      expect(custom?.token_endpoint_auth_method).toBeNull();
    });

    it("still resolves a healthy confidential client", async () => {
      await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "cid",
        clientSecret: "shh",
      });
      const out = await resolveForConnect();
      expect(out.clientId).toBe("cid");
      expect(out.clientSecret).toBe("shh");
    });

    it("still resolves a declared public client", async () => {
      await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "cid",
        clientSecret: "",
        tokenEndpointAuthMethod: "none",
      });
      const out = await resolveForConnect();
      expect(out.clientSecret).toBe("");
      expect(out.tokenEndpointAuthMethod).toBe("none");
    });
  });

  // Also from the review: `projectClientWithSecret` swallowed a decryption
  // failure into an empty secret, which the legacy fallback then reported as a
  // public client — handing the connect flow an empty credential for a row
  // that actually holds a secret nobody can read. A DIFFERENT state from the
  // legacy row (`secretReadable === false`, and the client HAS a secret), and
  // the projection must keep telling them apart.
  it("never reports an unreadable ciphertext as a public client", async () => {
    const id = await seedUnreadableRow();
    const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
    const custom = clients.find((c) => c.client_ref === id);
    expect(custom?.token_endpoint_auth_method).toBeNull();
    expect(custom?.has_client_secret).toBe(true);
  });

  it("surfaces the declaration in the client list the UI reads", async () => {
    await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
      clientId: "cid",
      clientSecret: "",
      tokenEndpointAuthMethod: "none",
    });
    const clients = await listIntegrationClients(scope, INTEGRATION, AUTH_KEY);
    const custom = clients.find((c) => c.source === "custom");
    expect(custom?.token_endpoint_auth_method).toBe("none");
    // The checkbox reads the declaration; `has_client_secret` alone could not
    // distinguish this from a confidential client whose secret was not re-typed.
    expect(custom?.has_client_secret).toBe(false);
  });
});
