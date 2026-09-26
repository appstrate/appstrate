// SPDX-License-Identifier: Apache-2.0

/**
 * Org-level integration OAuth clients (issue #1264): a client row with
 * `space_id IS NULL` is inherited by every space of its org. Resolution is
 * space > org > system — connect, both client lists, set-default and refresh by
 * id all read the same cascade.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace } from "../../helpers/seed.ts";
import { encryptCredentials } from "@appstrate/connect";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import {
  createIntegrationOAuthClient,
  deleteIntegrationOAuthClient,
  ensureIntegrationOAuthClient,
  getIntegrationAuthStatuses,
  listIntegrationClients,
  promoteIntegrationOAuthClient,
  resolveConnectClient,
  resolveIntegrationClientById,
  setDefaultIntegrationClient,
  updateIntegrationOAuthClient,
} from "../../../src/services/integration-connections.ts";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";
import type { OrgScope, SpaceScope } from "../../../src/lib/scope.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";

const INTEGRATION = "@myorg/probe";
const REMOTE = "@myorg/remote-mcp";
const AUTH_KEY = "primary";
const SYSTEM_ID = "probe-system";
const SYSTEM_ID_2 = "probe-system-2";

const DELIVERY = { http: { in: "header", name: "Authorization", value: "{$credential.token}" } };

const OAUTH2_AUTH = {
  type: "oauth2",
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  token_endpoint_auth_method: "client_secret_post",
  default_scopes: ["read"],
  authorized_uris: ["https://api.example.com/**"],
  delivery: DELIVERY,
} as unknown as AfpsManifestAuth;

function probeManifest(name: string): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name,
    version: "1.0.0",
    display_name: "Probe",
    source: { kind: "none" },
    auths: {
      [AUTH_KEY]: OAUTH2_AUTH,
      key: {
        type: "api_key",
        authorized_uris: ["https://api.example.com/**"],
        credentials: { schema: { type: "object", properties: { api_key: { type: "string" } } } },
        delivery: DELIVERY,
      },
    },
  } as unknown as IntegrationManifest;
}

const REMOTE_MANIFEST = {
  type: "integration",
  schema_version: "0.1",
  name: REMOTE,
  version: "1.0.0",
  display_name: "Remote MCP",
  description: "Remote MCP integration with MCP-spec auto-DCR",
  source: {
    kind: "remote",
    remote: { url: "https://mcp.invalid/mcp", transport: "streamable-http" },
  },
  auths: {
    oauth: {
      type: "oauth2",
      issuer: "https://mcp.invalid",
      token_endpoint_auth_method: "none",
      default_scopes: ["read"],
      authorized_uris: ["https://mcp.invalid/**"],
      delivery: DELIVERY,
    },
  },
} as unknown as IntegrationManifest;

describe("org-level integration OAuth clients", () => {
  let ctx: TestContext;
  let other: TestContext;
  let org: OrgScope;
  let spaceA: SpaceScope;
  let spaceB: SpaceScope;
  let otherSpace: SpaceScope;

  beforeEach(async () => {
    await truncateAll();
    __resetSystemIntegrationsForTest();
    ctx = await createTestContext({ orgSlug: "myorg" });
    other = await createTestContext({ orgSlug: "other" });
    org = { orgId: ctx.orgId };
    spaceA = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    const b = await seedSpace({ orgId: ctx.orgId, name: "B" });
    spaceB = { orgId: ctx.orgId, spaceId: b.id };
    otherSpace = { orgId: other.orgId, spaceId: other.defaultSpaceId };
    for (const [id, orgId, manifest] of [
      [INTEGRATION, ctx.orgId, probeManifest(INTEGRATION)],
      [REMOTE, ctx.orgId, REMOTE_MANIFEST],
      ["@other/probe", other.orgId, probeManifest("@other/probe")],
    ] as const) {
      await seedPackage({
        id,
        orgId,
        type: "integration",
        source: "local",
        draftManifest: manifest,
      });
    }
  });

  afterEach(() => __resetSystemIntegrationsForTest());

  /** Insert a client row directly: `spaceId: null` = org row. Returns its id. */
  async function seedClient(opts: {
    spaceId: string | null;
    clientId: string;
    isDefault?: boolean;
    orgId?: string;
    autoProvisioned?: boolean;
  }): Promise<string> {
    const [row] = await db
      .insert(integrationOauthClients)
      .values({
        orgId: opts.orgId ?? ctx.orgId,
        spaceId: opts.spaceId,
        integrationId: INTEGRATION,
        authKey: AUTH_KEY,
        clientId: opts.clientId,
        clientSecretEncrypted: encryptCredentials({ client_secret: `${opts.clientId}-secret` }),
        isDefault: opts.isDefault ?? false,
        autoProvisioned: opts.autoProvisioned ?? false,
      })
      .returning({ id: integrationOauthClients.id });
    return row!.id;
  }

  /** Register the system client (and a second one, `probe-system-2`, when asked). */
  function seedSystemClient(withSecond = false): void {
    const clients = [
      { id: SYSTEM_ID, auth_key: AUTH_KEY, client_id: "sys-client", client_secret: "sys" },
    ];
    if (withSecond) {
      clients.push({
        id: SYSTEM_ID_2,
        auth_key: AUTH_KEY,
        client_id: "sys-2",
        client_secret: "s2",
      });
    }
    initSystemIntegrations([{ id: INTEGRATION, clients }]);
  }

  /** The client a new connection in `scope` would use (the real connect path). */
  async function connectClientId(scope: SpaceScope): Promise<string> {
    const manifest = probeManifest(INTEGRATION);
    const resolved = await ensureIntegrationOAuthClient(
      scope,
      INTEGRATION,
      AUTH_KEY,
      manifest,
      OAUTH2_AUTH,
      "https://app.example.com/callback",
    );
    return resolveConnectClient(INTEGRATION, AUTH_KEY, manifest, OAUTH2_AUTH, resolved).clientId;
  }

  async function seedConnection(spaceId: string, userId: string, clientRef: string) {
    await db.insert(integrationConnections).values({
      integrationId: INTEGRATION,
      authKey: AUTH_KEY,
      accountId: `acct-${spaceId}`,
      spaceId,
      userId,
      credentialsEncrypted: "enc",
      clientRef,
    });
  }

  describe("connect cascade", () => {
    it("a space with no client of its own connects with the org default", async () => {
      seedSystemClient();
      await seedClient({ spaceId: null, clientId: "org-default", isDefault: true });
      expect(await connectClientId(spaceA)).toBe("org-default");
      expect(await connectClientId(spaceB)).toBe("org-default");
    });

    it("a flagged space client overrides the org default", async () => {
      await seedClient({ spaceId: null, clientId: "org-default", isDefault: true });
      await seedClient({ spaceId: spaceA.spaceId, clientId: "space-a", isDefault: true });
      expect(await connectClientId(spaceA)).toBe("space-a");
      expect(await connectClientId(spaceB)).toBe("org-default");
    });

    it("the org default beats unflagged space clients", async () => {
      await seedClient({ spaceId: spaceA.spaceId, clientId: "space-a" });
      await seedClient({ spaceId: null, clientId: "org-default", isDefault: true });
      expect(await connectClientId(spaceA)).toBe("org-default");
    });

    it("unflagged clients rank after system: first space client, then first org client", async () => {
      await seedClient({ spaceId: null, clientId: "org-unflagged" });
      expect(await connectClientId(spaceA)).toBe("org-unflagged");
      await seedClient({ spaceId: spaceA.spaceId, clientId: "space-unflagged" });
      expect(await connectClientId(spaceA)).toBe("space-unflagged");
      seedSystemClient();
      expect(await connectClientId(spaceA)).toBe("sys-client");
    });

    it("without org rows a space resolves as before (space default > system > first space)", async () => {
      seedSystemClient();
      await seedClient({ spaceId: spaceA.spaceId, clientId: "space-unflagged" });
      expect(await connectClientId(spaceA)).toBe("sys-client");
      __resetSystemIntegrationsForTest();
      expect(await connectClientId(spaceA)).toBe("space-unflagged");
    });

    it("never inherits another org's org clients", async () => {
      await seedClient({ spaceId: null, clientId: "org-default", isDefault: true });
      await expect(connectClientId(otherSpace)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("refresh by client_ref", () => {
    it("resolves an org client from every space of the org", async () => {
      const id = await seedClient({ spaceId: null, clientId: "org-client", isDefault: true });
      for (const scope of [spaceA, spaceB]) {
        const c = await resolveIntegrationClientById(
          id,
          scope.spaceId,
          INTEGRATION,
          AUTH_KEY,
          undefined,
        );
        expect(c).toMatchObject({ clientId: "org-client", clientSecret: "org-client-secret" });
      }
    });

    it("does not resolve an org client from a space of another org", async () => {
      const id = await seedClient({ spaceId: null, clientId: "org-client", isDefault: true });
      expect(
        await resolveIntegrationClientById(
          id,
          otherSpace.spaceId,
          INTEGRATION,
          AUTH_KEY,
          undefined,
        ),
      ).toBeNull();
    });
  });

  describe("lists", () => {
    const rows = (clients: Awaited<ReturnType<typeof listIntegrationClients>>) =>
      clients.map((c) => [c.client_ref, c.source, c.is_default]);

    it("org list: the inherited system default, then the org's own clients", async () => {
      seedSystemClient(true);
      const orgRow = await seedClient({ spaceId: null, clientId: "org-client" });
      await seedClient({ spaceId: spaceA.spaceId, clientId: "space-a", isDefault: true });
      expect(rows(await listIntegrationClients(org, INTEGRATION, AUTH_KEY))).toEqual([
        [SYSTEM_ID, "built-in", true],
        [orgRow, "org", false],
      ]);
    });

    it("space list: the inherited org default, then the space's own clients", async () => {
      seedSystemClient();
      const orgDefault = await seedClient({ spaceId: null, clientId: "org-d", isDefault: true });
      await seedClient({ spaceId: null, clientId: "org-o" });
      const own = await seedClient({
        spaceId: spaceA.spaceId,
        clientId: "space-a",
        isDefault: true,
      });
      expect(rows(await listIntegrationClients(spaceA, INTEGRATION, AUTH_KEY))).toEqual([
        [orgDefault, "org", false],
        [own, "custom", true],
      ]);
      expect(rows(await listIntegrationClients(spaceB, INTEGRATION, AUTH_KEY))).toEqual([
        [orgDefault, "org", true],
      ]);
    });

    it("space list: an unflagged own client is not listed twice as the inherited default", async () => {
      const own = await seedClient({ spaceId: spaceA.spaceId, clientId: "space-a" });
      await seedClient({ spaceId: null, clientId: "org-o" });
      expect(rows(await listIntegrationClients(spaceA, INTEGRATION, AUTH_KEY))).toEqual([
        [own, "custom", true],
      ]);
    });
  });

  describe("set default", () => {
    async function spaceDefault(): Promise<string | undefined> {
      const clients = await listIntegrationClients(spaceA, INTEGRATION, AUTH_KEY);
      return clients.find((c) => c.is_default)?.client_ref;
    }

    it("space tier: selecting the inherited default clears the space flags", async () => {
      const orgDefault = await seedClient({ spaceId: null, clientId: "org-d", isDefault: true });
      const own = await seedClient({
        spaceId: spaceA.spaceId,
        clientId: "space-a",
        isDefault: true,
      });
      expect(await spaceDefault()).toBe(own);
      await setDefaultIntegrationClient(spaceA, INTEGRATION, AUTH_KEY, orgDefault);
      expect(await spaceDefault()).toBe(orgDefault);
      await setDefaultIntegrationClient(spaceA, INTEGRATION, AUTH_KEY, own);
      expect(await spaceDefault()).toBe(own);
    });

    it("space tier: an org client that is not the inherited default is a 400", async () => {
      seedSystemClient();
      const orgOther = await seedClient({ spaceId: null, clientId: "org-o" });
      await seedClient({ spaceId: spaceA.spaceId, clientId: "space-a", isDefault: true });
      // Inherited default is the system client (no org default).
      await expect(
        setDefaultIntegrationClient(spaceA, INTEGRATION, AUTH_KEY, orgOther),
      ).rejects.toMatchObject({ status: 400 });
      await setDefaultIntegrationClient(spaceA, INTEGRATION, AUTH_KEY, SYSTEM_ID);
      expect(await spaceDefault()).toBe(SYSTEM_ID);
    });

    it("org tier: flags an org client; the inherited system default clears the org flags", async () => {
      seedSystemClient();
      const first = (
        await createIntegrationOAuthClient(org, INTEGRATION, AUTH_KEY, {
          clientId: "org-1",
          clientSecret: "s1",
        })
      ).id;
      const second = (
        await createIntegrationOAuthClient(org, INTEGRATION, AUTH_KEY, {
          clientId: "org-2",
          clientSecret: "s2",
        })
      ).id;
      const orgDefault = async () =>
        (await listIntegrationClients(org, INTEGRATION, AUTH_KEY)).find((c) => c.is_default)
          ?.client_ref;
      expect(await orgDefault()).toBe(first);
      await setDefaultIntegrationClient(org, INTEGRATION, AUTH_KEY, second);
      expect(await orgDefault()).toBe(second);
      await setDefaultIntegrationClient(org, INTEGRATION, AUTH_KEY, SYSTEM_ID);
      expect(await orgDefault()).toBe(SYSTEM_ID);
      // The org tier moved; spaceA (no own rows) inherits it.
      expect(await spaceDefault()).toBe(SYSTEM_ID);
    });

    it("org tier: a system client other than the inherited default is a 400", async () => {
      seedSystemClient(true);
      await seedClient({ spaceId: null, clientId: "org-client", isDefault: true });
      await expect(
        setDefaultIntegrationClient(org, INTEGRATION, AUTH_KEY, SYSTEM_ID_2),
      ).rejects.toMatchObject({ status: 400 });
      await setDefaultIntegrationClient(org, INTEGRATION, AUTH_KEY, SYSTEM_ID);
    });

    it("org tier: a space client or an unknown ref is a 400", async () => {
      const own = await seedClient({
        spaceId: spaceA.spaceId,
        clientId: "space-a",
        isDefault: true,
      });
      for (const ref of [own, "does-not-exist"]) {
        await expect(
          setDefaultIntegrationClient(org, INTEGRATION, AUTH_KEY, ref),
        ).rejects.toMatchObject({ status: 400 });
      }
    });
  });

  describe("org create guards", () => {
    it("stores an org row (spaceId null), default when first", async () => {
      const client = await createIntegrationOAuthClient(org, INTEGRATION, AUTH_KEY, {
        clientId: "org-1",
        clientSecret: "s1",
      });
      expect(client).toMatchObject({ spaceId: null, isDefault: true, client_id: "org-1" });
      // A space client created afterwards is still the default of its own tier.
      const own = await createIntegrationOAuthClient(spaceA, INTEGRATION, AUTH_KEY, {
        clientId: "space-a",
        clientSecret: "sa",
      });
      expect(own.isDefault).toBe(true);
    });

    it("rejects a non-oauth2 auth", async () => {
      await expect(
        createIntegrationOAuthClient(org, INTEGRATION, "key", { clientId: "x", clientSecret: "s" }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("rejects a manual client on an auto-provisioned (DCR/CIMD) auth at both tiers", async () => {
      for (const owner of [org, spaceA]) {
        await expect(
          createIntegrationOAuthClient(owner, REMOTE, "oauth", {
            clientId: "x",
            clientSecret: "s",
          }),
        ).rejects.toMatchObject({ status: 400 });
      }
      // The DCR path itself still registers its space client.
      const dcr = await createIntegrationOAuthClient(
        spaceA,
        REMOTE,
        "oauth",
        { clientId: "dcr", clientSecret: "", tokenEndpointAuthMethod: "none" },
        { autoProvisioned: true },
      );
      expect(dcr).toMatchObject({ spaceId: spaceA.spaceId, autoProvisioned: true });
    });

    it("rejects an integration of another org", async () => {
      await expect(
        createIntegrationOAuthClient(org, "@other/probe", AUTH_KEY, {
          clientId: "x",
          clientSecret: "s",
        }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("update / delete by id", () => {
    const input = { clientId: "rotated", clientSecret: "new" };

    it("update matches the tier and the integration (404 otherwise)", async () => {
      const orgRow = await seedClient({ spaceId: null, clientId: "org-client" });
      const spaceRow = await seedClient({ spaceId: spaceA.spaceId, clientId: "space-a" });
      for (const [owner, id, pkg] of [
        [spaceA, orgRow, INTEGRATION],
        [org, spaceRow, INTEGRATION],
        [spaceA, spaceRow, REMOTE],
        [org, orgRow, REMOTE],
      ] as const) {
        await expect(updateIntegrationOAuthClient(owner, pkg, id, input)).rejects.toMatchObject({
          status: 404,
        });
      }
      const rotated = await updateIntegrationOAuthClient(org, INTEGRATION, orgRow, input);
      expect(rotated).toMatchObject({ client_id: "rotated", spaceId: null });
    });

    it("delete matches the tier and the integration (404 otherwise)", async () => {
      const orgRow = await seedClient({ spaceId: null, clientId: "org-client" });
      const spaceRow = await seedClient({ spaceId: spaceA.spaceId, clientId: "space-a" });
      for (const [owner, id, pkg] of [
        [spaceA, orgRow, INTEGRATION],
        [org, spaceRow, INTEGRATION],
        [spaceA, spaceRow, REMOTE],
      ] as const) {
        await expect(deleteIntegrationOAuthClient(owner, pkg, id)).rejects.toMatchObject({
          status: 404,
        });
      }
      expect(await deleteIntegrationOAuthClient(spaceA, INTEGRATION, spaceRow)).toEqual({
        deletedConnections: 0,
      });
    });

    it("org delete cascades the connections of every space of the org, not another org's", async () => {
      const orgRow = await seedClient({ spaceId: null, clientId: "org-client", isDefault: true });
      await seedConnection(spaceA.spaceId, ctx.user.id, orgRow);
      await seedConnection(spaceB.spaceId, ctx.user.id, orgRow);
      await seedConnection(otherSpace.spaceId, other.user.id, orgRow);
      expect(await deleteIntegrationOAuthClient(org, INTEGRATION, orgRow)).toEqual({
        deletedConnections: 2,
      });
      const left = await db
        .select({ spaceId: integrationConnections.spaceId })
        .from(integrationConnections)
        .where(eq(integrationConnections.clientRef, orgRow));
      expect(left).toEqual([{ spaceId: otherSpace.spaceId }]);
    });
  });

  describe("promote", () => {
    it("moves a space client to the org; pinned connections still resolve from every space", async () => {
      const id = await seedClient({
        spaceId: spaceA.spaceId,
        clientId: "space-a",
        isDefault: true,
      });
      await seedConnection(spaceA.spaceId, ctx.user.id, id);
      const promoted = await promoteIntegrationOAuthClient(spaceA, INTEGRATION, id);
      expect(promoted).toMatchObject({ id, spaceId: null, isDefault: true, client_id: "space-a" });
      for (const scope of [spaceA, spaceB]) {
        expect(
          await resolveIntegrationClientById(id, scope.spaceId, INTEGRATION, AUTH_KEY, undefined),
        ).toMatchObject({ clientId: "space-a", clientSecret: "space-a-secret" });
      }
      const [conn] = await db
        .select({ clientRef: integrationConnections.clientRef })
        .from(integrationConnections)
        .where(eq(integrationConnections.spaceId, spaceA.spaceId));
      expect(conn?.clientRef).toBe(id);
    });

    it("keeps the org's existing default", async () => {
      const orgDefault = await seedClient({ spaceId: null, clientId: "org-d", isDefault: true });
      const id = await seedClient({
        spaceId: spaceA.spaceId,
        clientId: "space-a",
        isDefault: true,
      });
      expect(await promoteIntegrationOAuthClient(spaceA, INTEGRATION, id)).toMatchObject({
        spaceId: null,
        isDefault: false,
      });
      const clients = await listIntegrationClients(org, INTEGRATION, AUTH_KEY);
      expect(clients.find((c) => c.is_default)?.client_ref).toBe(orgDefault);
    });

    it("404s another space's client, an org client and another integration's id", async () => {
      const spaceBRow = await seedClient({ spaceId: spaceB.spaceId, clientId: "space-b" });
      const orgRow = await seedClient({ spaceId: null, clientId: "org-client" });
      const own = await seedClient({ spaceId: spaceA.spaceId, clientId: "space-a" });
      for (const [id, pkg] of [
        [spaceBRow, INTEGRATION],
        [orgRow, INTEGRATION],
        [own, REMOTE],
      ] as const) {
        await expect(promoteIntegrationOAuthClient(spaceA, pkg, id)).rejects.toMatchObject({
          status: 404,
        });
      }
    });

    it("400s an auto-provisioned client", async () => {
      const id = await seedClient({
        spaceId: spaceA.spaceId,
        clientId: "dcr",
        isDefault: true,
        autoProvisioned: true,
      });
      await expect(promoteIntegrationOAuthClient(spaceA, INTEGRATION, id)).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  it("has_oauth_client is true when only an org client exists", async () => {
    await seedClient({ spaceId: null, clientId: "org-client", isDefault: true });
    const { auths } = await getIntegrationAuthStatuses(spaceA, INTEGRATION, {
      type: "user",
      id: ctx.user.id,
    });
    expect(auths.find((a) => a.auth_key === AUTH_KEY)?.has_oauth_client).toBe(true);
    expect(auths.find((a) => a.auth_key === "key")?.has_oauth_client).toBe(false);
  });
});
