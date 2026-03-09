import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  queues,
  resetQueues,
  db,
  schemaStubs,
  tracking,
  packageVersionsStub,
  systemPackagesStub,
} from "../../services/__tests__/_db-mock.ts";

// --- Configurable mock state ---

let mockFlows: { manifest: Record<string, unknown> }[] = [];
const encryptCalls: Record<string, string>[] = [];
const versionUploadCalls: unknown[] = [];

// --- Mocks (must be before dynamic import) ---

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));

const providerCredentialsStub = {
  providerId: "provider_id",
  orgId: "org_id",
  credentialsEncrypted: "credentials_encrypted",
  enabled: "enabled",
  updatedAt: "updated_at",
};

mock.module("@appstrate/db/schema", () => ({
  ...schemaStubs,
  providerCredentials: providerCredentialsStub,
}));

mock.module("@appstrate/env", () => ({
  getEnv: () => ({ APP_URL: "http://localhost:3010" }),
}));

mock.module("../../middleware/guards.ts", () => ({
  requireAdmin: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@appstrate/connect", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s,
  encryptCredentials: (creds: Record<string, string>) => {
    encryptCalls.push(creds);
    return `encrypted:${JSON.stringify(creds)}`;
  },
  decryptCredentials: <T>(s: string) => JSON.parse(s.replace("encrypted:", "")) as T,
  validateScopes: () => ({ sufficient: true, granted: [], required: [], missing: [] }),
  getConnection: async () => null,
  listConnections: async () => [],
  getCredentials: async () => null,
  resolveCredentialsForProxy: async () => null,
  saveConnection: async () => {},
  deleteConnection: async () => {},
  initiateOAuth: async () => ({}),
  handleOAuthCallback: async () => ({}),
  initiateOAuth1: async () => ({}),
  handleOAuth1Callback: async () => ({}),
}));

mock.module("../../services/flow-service.ts", () => ({
  getPackage: async () => null,
  listPackages: async () => mockFlows,
  getAllPackageIds: async () => [],
  packageExists: async () => false,
}));

mock.module("../../services/system-packages.ts", () => ({
  ...systemPackagesStub,
}));

// manifest-utils.ts is NOT mocked — pure functions, no side effects.
// Using real implementation avoids mock.module process-global contamination.

mock.module("../../services/package-versions.ts", () => ({
  ...packageVersionsStub,
  createVersionAndUpload: async (params: unknown) => {
    versionUploadCalls.push(params);
  },
}));

// @appstrate/core/semver — NOT mocked (pure functions, avoids process-global contamination)

// @appstrate/core/zip — NOT mocked (pure functions, avoids process-global contamination)

// drizzle-orm — NOT mocked. Pure functions (eq, and, or, isNull) work fine
// with the mock DB which ignores where-clause arguments.

// --- Dynamic import (after all mocks) ---

const { createProvidersRouter } = await import("../providers.ts");

// --- Test app ---

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("orgId" as never, "org-1" as never);
  c.set("user" as never, { id: "user-1", email: "test@test.com", name: "Test" } as never);
  c.set("orgRole" as never, "admin" as never);
  await next();
});
app.route("/api/providers", createProvidersRouter());

// --- Helpers ---

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "@test/new-provider",
    displayName: "Test Provider",
    authMode: "oauth2",
    ...overrides,
  };
}

function makePackageRow(
  overrides: Partial<{ id: string; manifest: Record<string, unknown>; source: string }> = {},
) {
  return {
    pkg: {
      id: "@test/provider",
      manifest: { displayName: "Test Provider", definition: { authMode: "oauth2" } },
      source: "local",
      ...overrides,
    },
  };
}

function makeCredRow(
  overrides: Partial<{
    providerId: string;
    credentialsEncrypted: string | null;
    enabled: boolean;
  }> = {},
) {
  return {
    providerId: "@test/provider",
    credentialsEncrypted: "encrypted-data",
    enabled: true,
    ...overrides,
  };
}

/** Push 2 empty selects for POST: isSystemProviderInDb + duplicate check */
function pushNoConflictQueues() {
  queues.select.push([]); // isSystemProviderInDb → not system
  queues.select.push([]); // existing check → no duplicate
}

function jsonRequest(path: string, method: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

// --- Reset ---

beforeEach(() => {
  resetQueues();
  encryptCalls.length = 0;
  versionUploadCalls.length = 0;
  mockFlows = [];
});

// ==================== GET /api/providers ====================

describe("GET /api/providers", () => {
  test("returns empty list when no providers", async () => {
    queues.select.push([]); // packages
    queues.select.push([]); // providerCredentials

    const res = await app.request("/api/providers");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { providers: unknown[] };
    expect(json.providers).toEqual([]);
  });

  test("returns system + custom providers with usage count", async () => {
    queues.select.push([makePackageRow()]); // packages
    mockFlows = [{ manifest: { requires: { providers: { "@test/provider": "1.0.0" } } } }];
    queues.select.push([makeCredRow()]); // providerCredentials

    const res = await app.request("/api/providers");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { providers: { id: string; usedByFlows: number }[] };
    expect(json.providers).toHaveLength(1);
    expect(json.providers[0]!.id).toBe("@test/provider");
    expect(json.providers[0]!.usedByFlows).toBe(1);
  });

  test("includes callbackUrl from env", async () => {
    queues.select.push([]); // packages
    queues.select.push([]); // providerCredentials

    const res = await app.request("/api/providers");
    const json = (await res.json()) as { callbackUrl: string };
    expect(json.callbackUrl).toBe("http://localhost:3010/api/auth/callback");
  });

  test("generates default adminCredentialSchema for oauth2", async () => {
    queues.select.push([
      makePackageRow({ manifest: { displayName: "OAuth2", definition: { authMode: "oauth2" } } }),
    ]);
    queues.select.push([]); // no credentials

    const res = await app.request("/api/providers");
    const json = (await res.json()) as {
      providers: { adminCredentialSchema: Record<string, unknown> }[];
    };
    expect(json.providers[0]!.adminCredentialSchema).toEqual({
      type: "object",
      properties: {
        clientId: { type: "string", description: "Client ID" },
        clientSecret: { type: "string", description: "Client Secret" },
      },
      required: ["clientId", "clientSecret"],
    });
  });
});

// ==================== POST /api/providers ====================

describe("POST /api/providers", () => {
  test("creates provider with valid data → 201", async () => {
    pushNoConflictQueues();

    const body = validCreateBody();
    const res = await jsonRequest("/api/providers", "POST", body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    expect(json.id).toBe("@test/new-provider");
    // packages insert + providerCredentials insert
    expect(tracking.insertCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("returns 400 on missing required fields", async () => {
    const res = await jsonRequest("/api/providers", "POST", { displayName: "Test" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  test("returns 403 when ID conflicts with system provider (source: system)", async () => {
    queues.select.push([{ source: "system" }]); // isSystemProviderInDb → system

    const res = await jsonRequest("/api/providers", "POST", validCreateBody());
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("OPERATION_NOT_ALLOWED");
  });

  test("returns 403 when ID conflicts with system provider (source: system)", async () => {
    queues.select.push([{ source: "system" }]); // isSystemProviderInDb → system

    const res = await jsonRequest("/api/providers", "POST", validCreateBody());
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("OPERATION_NOT_ALLOWED");
  });

  test("returns 400 on duplicate ID (NAME_COLLISION)", async () => {
    queues.select.push([]); // isSystemProviderInDb → not system
    queues.select.push([{ id: "@test/new-provider" }]); // existing check → found

    const res = await jsonRequest("/api/providers", "POST", validCreateBody());
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("NAME_COLLISION");
  });

  test("sets proxy defaults when authMode is proxy", async () => {
    pushNoConflictQueues();

    const res = await jsonRequest("/api/providers", "POST", validCreateBody({ authMode: "proxy" }));
    expect(res.status).toBe(201);

    const pkgInsert = tracking.insertCalls[0] as { manifest: Record<string, unknown> };
    const def = pkgInsert.manifest.definition as Record<string, unknown>;
    expect(def.allowAllUris).toBe(true);
    expect(def.credentialFieldName).toBe("url");
    expect((pkgInsert.manifest.categories as string[]).includes("proxy")).toBe(true);
  });

  test("encrypts admin credentials when clientId/clientSecret provided", async () => {
    pushNoConflictQueues();

    const res = await jsonRequest(
      "/api/providers",
      "POST",
      validCreateBody({ clientId: "cid", clientSecret: "csec" }),
    );
    expect(res.status).toBe(201);
    expect(encryptCalls.length).toBeGreaterThan(0);
    expect(encryptCalls[0]).toEqual({ clientId: "cid", clientSecret: "csec" });
  });

  test("does not encrypt when no credentials provided", async () => {
    pushNoConflictQueues();

    const res = await jsonRequest("/api/providers", "POST", validCreateBody());
    expect(res.status).toBe(201);
    expect(encryptCalls).toHaveLength(0);

    // providerCredentials insert should have null credentials
    const credInsert = tracking.insertCalls[1] as { credentialsEncrypted: unknown };
    expect(credInsert.credentialsEncrypted).toBeNull();
  });

  test("creates version when valid semver", async () => {
    pushNoConflictQueues();

    const res = await jsonRequest("/api/providers", "POST", validCreateBody({ version: "2.0.0" }));
    expect(res.status).toBe(201);
    expect(versionUploadCalls).toHaveLength(1);
    expect((versionUploadCalls[0] as { version: string }).version).toBe("2.0.0");
  });

  test("skips version when invalid semver", async () => {
    pushNoConflictQueues();

    const res = await jsonRequest(
      "/api/providers",
      "POST",
      validCreateBody({ version: "not-valid" }),
    );
    expect(res.status).toBe(201);
    expect(versionUploadCalls).toHaveLength(0);
  });
});

// ==================== PUT /api/providers/:scope/:name ====================

describe("PUT /api/providers/:scope/:name", () => {
  test("updates manifest → 200", async () => {
    queues.select.push([]); // isSystemProviderInDb → not system
    queues.select.push([{ manifest: { displayName: "Old", definition: { authMode: "oauth2" } } }]); // existing package

    const res = await jsonRequest("/api/providers/@test/provider", "PUT", {
      displayName: "New Name",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string };
    expect(json.id).toBe("@test/provider");
  });

  test("returns 403 for system provider", async () => {
    queues.select.push([{ source: "system" }]); // isSystemProviderInDb → system

    const res = await jsonRequest("/api/providers/@test/provider", "PUT", {
      displayName: "New",
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("OPERATION_NOT_ALLOWED");
  });

  test("returns 404 when not found", async () => {
    queues.select.push([]); // isSystemProviderInDb → not system
    queues.select.push([]); // existing package → not found

    const res = await jsonRequest("/api/providers/@test/provider", "PUT", {
      displayName: "New",
    });
    expect(res.status).toBe(404);
  });

  test("merges partial definition (preserves old values)", async () => {
    queues.select.push([]); // isSystemProviderInDb
    queues.select.push([
      {
        manifest: {
          displayName: "Old Name",
          description: "Old desc",
          definition: {
            authMode: "oauth2",
            authorizationUrl: "https://old.com/auth",
            tokenUrl: "https://old.com/token",
          },
        },
      },
    ]);

    const res = await jsonRequest("/api/providers/@test/provider", "PUT", {
      tokenUrl: "https://new.com/token",
    });
    expect(res.status).toBe(200);

    const upd = tracking.updateCalls[0] as { manifest: Record<string, unknown> };
    expect(upd.manifest.displayName).toBe("Old Name"); // preserved
    expect(upd.manifest.description).toBe("Old desc"); // preserved
    const def = upd.manifest.definition as Record<string, unknown>;
    expect(def.authorizationUrl).toBe("https://old.com/auth"); // preserved
    expect(def.tokenUrl).toBe("https://new.com/token"); // updated
  });

  test("forces proxy defaults on authMode change", async () => {
    queues.select.push([]); // isSystemProviderInDb
    queues.select.push([
      { manifest: { displayName: "Provider", definition: { authMode: "oauth2" } } },
    ]);

    const res = await jsonRequest("/api/providers/@test/provider", "PUT", {
      authMode: "proxy",
    });
    expect(res.status).toBe(200);

    const upd = tracking.updateCalls[0] as { manifest: Record<string, unknown> };
    const def = upd.manifest.definition as Record<string, unknown>;
    expect(def.allowAllUris).toBe(true);
    expect(def.credentialFieldName).toBe("url");
  });

  test("updates credentials when clientId/clientSecret provided", async () => {
    queues.select.push([]); // isSystemProviderInDb
    queues.select.push([
      { manifest: { displayName: "Provider", definition: { authMode: "oauth2" } } },
    ]);

    const res = await jsonRequest("/api/providers/@test/provider", "PUT", {
      clientId: "new-id",
      clientSecret: "new-secret",
    });
    expect(res.status).toBe(200);
    expect(encryptCalls.length).toBeGreaterThan(0);
    // providerCredentials insert for credential update
    expect(tracking.insertCalls).toHaveLength(1);
  });

  test("does not touch credentials when none provided", async () => {
    queues.select.push([]); // isSystemProviderInDb
    queues.select.push([
      { manifest: { displayName: "Provider", definition: { authMode: "oauth2" } } },
    ]);

    const res = await jsonRequest("/api/providers/@test/provider", "PUT", {
      displayName: "Updated",
    });
    expect(res.status).toBe(200);
    expect(encryptCalls).toHaveLength(0);
    expect(tracking.insertCalls).toHaveLength(0);
  });
});

// ==================== DELETE /api/providers/:scope/:name ====================

describe("DELETE /api/providers/:scope/:name", () => {
  test("deletes custom provider → 204", async () => {
    queues.select.push([]); // isSystemProviderInDb → not system
    mockFlows = []; // no flows using it

    const res = await app.request("/api/providers/@test/provider", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(tracking.deleteCalls).toHaveLength(1);
  });

  test("returns 403 for system provider", async () => {
    queues.select.push([{ source: "system" }]); // isSystemProviderInDb → system

    const res = await app.request("/api/providers/@test/provider", { method: "DELETE" });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("OPERATION_NOT_ALLOWED");
  });

  test("returns 409 when provider in use by 1 flow", async () => {
    queues.select.push([]); // isSystemProviderInDb → not system
    mockFlows = [{ manifest: { requires: { providers: { "@test/provider": "1.0.0" } } } }];

    const res = await app.request("/api/providers/@test/provider", { method: "DELETE" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("PROVIDER_IN_USE");
    expect(json.message).toContain("1 flow(s)");
  });

  test("returns 409 with correct count for multiple flows", async () => {
    queues.select.push([]); // isSystemProviderInDb → not system
    mockFlows = [
      { manifest: { requires: { providers: { "@test/provider": "1.0.0" } } } },
      { manifest: { requires: { providers: { "@test/provider": "2.0.0" } } } },
      { manifest: { requires: { providers: { "@other/provider": "1.0.0" } } } },
    ];

    const res = await app.request("/api/providers/@test/provider", { method: "DELETE" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { message: string };
    expect(json.message).toContain("2 flow(s)");
  });
});

// ==================== PUT /api/providers/credentials/:scope/:name ====================

describe("PUT /api/providers/credentials/:scope/:name", () => {
  test("configures credentials → 200", async () => {
    queues.select.push([
      { id: "@test/provider", manifest: { definition: { authMode: "oauth2" } } },
    ]); // provider exists

    const res = await jsonRequest("/api/providers/credentials/@test/provider", "PUT", {
      credentials: { clientId: "id", clientSecret: "secret" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { configured: boolean };
    expect(json.configured).toBe(true);
  });

  test("returns 404 for non-existent provider", async () => {
    queues.select.push([]); // provider not found

    const res = await jsonRequest("/api/providers/credentials/@test/provider", "PUT", {
      credentials: { clientId: "id", clientSecret: "secret" },
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("NOT_FOUND");
  });

  test("returns 400 when required fields missing (oauth2 default schema)", async () => {
    queues.select.push([
      { id: "@test/provider", manifest: { definition: { authMode: "oauth2" } } },
    ]);

    const res = await jsonRequest("/api/providers/credentials/@test/provider", "PUT", {
      credentials: { clientId: "id" }, // missing clientSecret
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.message).toContain("clientSecret");
  });

  test("supports partial update (only enabled flag)", async () => {
    queues.select.push([
      { id: "@test/provider", manifest: { definition: { authMode: "oauth2" } } },
    ]);

    const res = await jsonRequest("/api/providers/credentials/@test/provider", "PUT", {
      enabled: true,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { configured: boolean };
    expect(json.configured).toBe(true);
    // No encrypt calls since no credentials provided
    expect(encryptCalls).toHaveLength(0);
  });

  test("encrypts credentials before storage", async () => {
    queues.select.push([
      { id: "@test/provider", manifest: { definition: { authMode: "oauth2" } } },
    ]);

    const res = await jsonRequest("/api/providers/credentials/@test/provider", "PUT", {
      credentials: { clientId: "abc", clientSecret: "xyz" },
    });
    expect(res.status).toBe(200);
    expect(encryptCalls.length).toBeGreaterThan(0);

    const insertCall = tracking.insertCalls[0] as { credentialsEncrypted: string };
    expect(insertCall.credentialsEncrypted).toContain("encrypted:");
  });

  test("validates against custom adminCredentialSchema", async () => {
    queues.select.push([
      {
        id: "@test/provider",
        manifest: {
          definition: {
            authMode: "custom",
            adminCredentialSchema: {
              type: "object",
              properties: { apiToken: { type: "string" } },
              required: ["apiToken"],
            },
          },
        },
      },
    ]);

    const res = await jsonRequest("/api/providers/credentials/@test/provider", "PUT", {
      credentials: { someOtherField: "value" }, // missing apiToken
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { message: string };
    expect(json.message).toContain("apiToken");
  });
});

// ==================== DELETE /api/providers/credentials/:scope/:name ====================

describe("DELETE /api/providers/credentials/:scope/:name", () => {
  test("clears credentials and disables → { configured: false }", async () => {
    const res = await app.request("/api/providers/credentials/@test/provider", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { configured: boolean };
    expect(json.configured).toBe(false);

    expect(tracking.updateCalls).toHaveLength(1);
    expect(tracking.updateCalls[0]!.credentialsEncrypted).toBeNull();
    expect(tracking.updateCalls[0]!.enabled).toBe(false);
  });
});
