import { describe, test, expect, mock, beforeEach } from "bun:test";
import { queues, resetQueues, db } from "./_db-mock.ts";

// --- Mocks (must be before dynamic import) ---

const noop = () => {};
mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));

// Schema stubs for serviceConnections (must have column names matching queries)
const serviceConnectionsStub = {
  id: "id",
  profileId: "profile_id",
  providerId: "provider_id",
  orgId: "org_id",
  credentialsEncrypted: "credentials_encrypted",
  scopesGranted: "scopes_granted",
  expiresAt: "expires_at",
  rawTokenResponse: "raw_token_response",
  metadata: "metadata",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const connectionProfilesStub = {
  id: "id",
  userId: "user_id",
  name: "name",
  isDefault: "is_default",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const organizationMembersStub = {
  orgId: "org_id",
  userId: "user_id",
};

const organizationsStub = {
  id: "id",
  name: "name",
};

const packagesStub = {
  id: "id",
  type: "type",
  orgId: "org_id",
  draftManifest: "draft_manifest",
};

const providerCredentialsStub = {
  providerId: "provider_id",
  orgId: "org_id",
  credentialsEncrypted: "credentials_encrypted",
  enabled: "enabled",
  updatedAt: "updated_at",
};

mock.module("@appstrate/db/schema", () => ({
  serviceConnections: serviceConnectionsStub,
  connectionProfiles: connectionProfilesStub,
  organizationMembers: organizationMembersStub,
  organizations: organizationsStub,
  packages: packagesStub,
  providerCredentials: providerCredentialsStub,
}));

// Mock encryption to be transparent
mock.module("@appstrate/connect", () => {
  // We need to re-export what the service layer imports
  return {
    encrypt: (s: string) => `enc:${s}`,
    decrypt: (s: string) => s,
    encryptCredentials: (creds: Record<string, string>) => `encrypted:${JSON.stringify(creds)}`,
    decryptCredentials: <T>(s: string) => JSON.parse(s.replace("encrypted:", "")) as T,
    validateScopes: () => ({ sufficient: true, granted: [], required: [], missing: [] }),
    // Provide real-ish stubs for credential functions that delegate to DB
    getConnection: mock(async () => null),
    listConnections: mock(async () => []),
    getCredentials: mock(async () => null),
    resolveCredentialsForProxy: mock(async () => null),
    saveConnection: mock(async () => {}),
    deleteConnection: mock(async () => {}),
    deleteConnectionById: mock(async () => {}),
    initiateOAuth: mock(async () => ({})),
    handleOAuthCallback: mock(async () => ({})),
    initiateOAuth1: mock(async () => ({})),
    handleOAuth1Callback: mock(async () => ({})),
    isProviderEnabled: mock(async () => true),
    getProvider: mock(async () => null),
    listProviders: mock(async () => []),
    getProviderAuthMode: mock(async () => "oauth2"),
    getDefaultAuthorizedUris: mock(async () => []),
    getCredentialFieldName: mock(async () => "token"),
    hasCredentialsConfigured: mock(async () => false),
    getProviderOrThrow: mock(async () => ({})),
    getProviderOAuthCredentials: mock(async () => null),
    getProviderOAuthCredentialsOrThrow: mock(async () => ({})),
    getProviderOAuth1CredentialsOrThrow: mock(async () => ({})),
  };
});

mock.module("@appstrate/env", () => ({
  getEnv: () => ({ APP_URL: "http://localhost:3000" }),
}));

mock.module("../../services/connection-profiles.ts", () => ({
  getEffectiveProfileId: async () => "profile-1",
}));

// --- Dynamic imports (after mocks) ---

const { saveApiKeyConnection, saveCredentialsConnection } =
  await import("../connection-manager/credentials.ts");

const { listUserConnections, disconnectProvider } =
  await import("../connection-manager/operations.ts");

const { getConnectionStatus } = await import("../connection-manager/status.ts");

const { listAllUserConnections } = await import("../connection-manager/providers.ts");

// --- Reset ---

beforeEach(() => {
  resetQueues();
});

// ==================== Service: saveApiKeyConnection ====================

describe("saveApiKeyConnection", () => {
  test("passes orgId to saveConnection", async () => {
    const { saveConnection } = await import("@appstrate/connect");
    await saveApiKeyConnection("@test/provider", "my-api-key", "profile-1", "org-1");

    expect(saveConnection).toHaveBeenCalledWith(db, "profile-1", "@test/provider", "org-1", {
      api_key: "my-api-key",
    });
  });
});

describe("saveCredentialsConnection", () => {
  test("passes orgId to saveConnection", async () => {
    const { saveConnection } = await import("@appstrate/connect");
    const creds = { username: "user", password: "pass" };
    await saveCredentialsConnection("@test/provider", "basic", creds, "profile-1", "org-2");

    expect(saveConnection).toHaveBeenCalledWith(db, "profile-1", "@test/provider", "org-2", creds);
  });
});

// ==================== Service: listUserConnections ====================

describe("listUserConnections", () => {
  test("passes orgId to listConnections", async () => {
    const { listConnections } = await import("@appstrate/connect");
    await listUserConnections("profile-1", "org-1");

    expect(listConnections).toHaveBeenCalledWith(db, "profile-1", "org-1");
  });
});

// ==================== Service: disconnectProvider ====================

describe("disconnectProvider", () => {
  test("passes orgId to deleteConnection", async () => {
    const { deleteConnection } = await import("@appstrate/connect");
    await disconnectProvider("@test/provider", "profile-1", "org-1");

    expect(deleteConnection).toHaveBeenCalledWith(db, "profile-1", "@test/provider", "org-1");
  });
});

// ==================== Service: getConnectionStatus ====================

describe("getConnectionStatus", () => {
  test("passes orgId to getConnection", async () => {
    const { getConnection } = await import("@appstrate/connect");
    await getConnectionStatus("@test/provider", "profile-1", "org-1");

    expect(getConnection).toHaveBeenCalledWith(db, "profile-1", "@test/provider", "org-1");
  });

  test("returns not_connected when no connection found", async () => {
    const result = await getConnectionStatus("@test/provider", "profile-1", "org-1");
    expect(result.status).toBe("not_connected");
    expect(result.provider).toBe("@test/provider");
  });
});

// ==================== Service: listAllUserConnections ====================

describe("listAllUserConnections", () => {
  test("returns empty providers when no connections", async () => {
    queues.select.push([]); // serviceConnections join

    const result = await listAllUserConnections("user-1");
    expect(result.providers).toEqual([]);
  });

  test("groups connections by provider then org", async () => {
    // 1. serviceConnections query
    queues.select.push([
      {
        connectionId: "conn-1",
        providerId: "@test/gmail",
        orgId: "org-1",
        scopesGranted: ["read"],
        connectedAt: new Date("2026-01-01"),
        profileId: "profile-1",
        profileName: "Default",
        isDefault: true,
      },
      {
        connectionId: "conn-2",
        providerId: "@test/gmail",
        orgId: "org-2",
        scopesGranted: ["read", "write"],
        connectedAt: new Date("2026-01-15"),
        profileId: "profile-1",
        profileName: "Default",
        isDefault: true,
      },
      {
        connectionId: "conn-3",
        providerId: "@test/clickup",
        orgId: "org-1",
        scopesGranted: [],
        connectedAt: new Date("2026-02-01"),
        profileId: "profile-2",
        profileName: "Work",
        isDefault: false,
      },
    ]);

    // 2. organizationMembers join → org names
    queues.select.push([
      { orgId: "org-1", orgName: "Mon Agence" },
      { orgId: "org-2", orgName: "Projet Perso" },
    ]);

    // 3. packages query for provider info
    queues.select.push([
      {
        id: "@test/gmail",
        draftManifest: { displayName: "Gmail", iconUrl: "https://example.com/gmail.png" },
      },
      { id: "@test/clickup", draftManifest: { displayName: "ClickUp" } },
    ]);

    const result = await listAllUserConnections("user-1");

    // Two provider groups
    expect(result.providers).toHaveLength(2);

    // Gmail: 2 connections across 2 orgs
    const gmail = result.providers.find((p) => p.providerId === "@test/gmail")!;
    expect(gmail.displayName).toBe("Gmail");
    expect(gmail.logo).toBe("https://example.com/gmail.png");
    expect(gmail.totalConnections).toBe(2);
    expect(gmail.orgs).toHaveLength(2);

    const gmailOrg1 = gmail.orgs.find((o) => o.orgId === "org-1")!;
    expect(gmailOrg1.orgName).toBe("Mon Agence");
    expect(gmailOrg1.connections).toHaveLength(1);
    expect(gmailOrg1.connections[0]!.connectionId).toBe("conn-1");

    const gmailOrg2 = gmail.orgs.find((o) => o.orgId === "org-2")!;
    expect(gmailOrg2.orgName).toBe("Projet Perso");
    expect(gmailOrg2.connections).toHaveLength(1);
    expect(gmailOrg2.connections[0]!.connectionId).toBe("conn-2");
    expect(gmailOrg2.connections[0]!.scopesGranted).toEqual(["read", "write"]);

    // ClickUp: 1 connection in 1 org
    const clickup = result.providers.find((p) => p.providerId === "@test/clickup")!;
    expect(clickup.displayName).toBe("ClickUp");
    expect(clickup.logo).toBe("");
    expect(clickup.totalConnections).toBe(1);
    expect(clickup.orgs).toHaveLength(1);
    expect(clickup.orgs[0]!.connections[0]!.profile.name).toBe("Work");
    expect(clickup.orgs[0]!.connections[0]!.profile.isDefault).toBe(false);
  });

  test("multiple profiles in same org appear as separate connections", async () => {
    queues.select.push([
      {
        connectionId: "conn-1",
        providerId: "@test/gmail",
        orgId: "org-1",
        scopesGranted: [],
        connectedAt: new Date("2026-01-01"),
        profileId: "profile-1",
        profileName: "Default",
        isDefault: true,
      },
      {
        connectionId: "conn-2",
        providerId: "@test/gmail",
        orgId: "org-1",
        scopesGranted: [],
        connectedAt: new Date("2026-01-15"),
        profileId: "profile-2",
        profileName: "Client",
        isDefault: false,
      },
    ]);

    queues.select.push([{ orgId: "org-1", orgName: "Mon Agence" }]);
    queues.select.push([{ id: "@test/gmail", draftManifest: { displayName: "Gmail" } }]);

    const result = await listAllUserConnections("user-1");

    expect(result.providers).toHaveLength(1);
    const gmail = result.providers[0]!;
    expect(gmail.totalConnections).toBe(2);
    expect(gmail.orgs).toHaveLength(1);

    // Both connections in same org
    const org = gmail.orgs[0]!;
    expect(org.connections).toHaveLength(2);
    expect(org.connections[0]!.profile.name).toBe("Default");
    expect(org.connections[1]!.profile.name).toBe("Client");
  });
});
