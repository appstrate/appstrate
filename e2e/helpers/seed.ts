// SPDX-License-Identifier: Apache-2.0

/**
 * E2E seed helpers — create test resources via the real API.
 *
 * Unlike integration test seeds (which insert DB rows directly),
 * these go through the actual HTTP endpoints to test the full stack.
 */

import type { ApiClient } from "./api-client.ts";
import type { APIRequestContext } from "@playwright/test";
import { createOrgOnlyClient } from "./api-client.ts";

// ─── Auth ────────────────────────────────────────

export interface AuthResult {
  userId: string;
  email: string;
  name: string;
  cookie: string;
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function registerUser(
  request: APIRequestContext,
  overrides: { email?: string; name?: string; password?: string } = {},
): Promise<AuthResult> {
  const tag = uid();
  const email = overrides.email ?? `e2e-${tag}@test.com`;
  const name = overrides.name ?? `E2E User ${tag}`;
  const password = overrides.password ?? "TestPassword123!";

  const res = await request.post("/api/auth/sign-up/email", {
    headers: { Origin: "http://localhost:3000" },
    data: { email, password, name },
  });

  if (res.status() !== 200) {
    throw new Error(`Sign-up failed (${res.status()}): ${await res.text()}`);
  }

  const setCookie = res.headers()["set-cookie"] ?? "";
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) {
    throw new Error(`No session cookie in sign-up response: ${setCookie}`);
  }

  const body = await res.json();
  return {
    userId: body.user.id,
    email: body.user.email,
    name: body.user.name,
    cookie: `better-auth.session_token=${match[1]}`,
  };
}

// ─── Organizations ──────────────────────────────

export interface OrgResult {
  orgId: string;
  orgName: string;
  orgSlug: string;
  defaultAppId: string;
}

export async function createOrg(
  request: APIRequestContext,
  cookie: string,
  overrides: { name?: string; slug?: string } = {},
): Promise<OrgResult> {
  const tag = uid();
  const name = overrides.name ?? `E2E Org ${tag}`;
  const slug = overrides.slug ?? `e2e-org-${tag}`;

  const res = await request.post("/api/orgs", {
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    data: { name, slug },
  });

  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`Create org failed (${res.status()}): ${await res.text()}`);
  }

  const body = await res.json();
  const orgId = body.id;

  // Fetch apps to find the default one (retry once on connection reset)
  let defaultApp: { id: string } | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const appsRes = await request.get("/api/applications", {
        headers: { Cookie: cookie, "X-Org-Id": orgId },
      });
      const appsBody = await appsRes.json();
      defaultApp = appsBody.data?.find((a: { isDefault: boolean }) => a.isDefault);
      if (defaultApp) break;
    } catch {
      if (attempt === 2) throw new Error("Failed to fetch applications after 3 attempts");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!defaultApp) {
    throw new Error("No default application found after org creation");
  }

  return {
    orgId,
    orgName: name,
    orgSlug: slug,
    defaultAppId: defaultApp.id,
  };
}

// ─── Applications ───────────────────────────────

export async function createApplication(
  client: ApiClient | ReturnType<typeof createOrgOnlyClient>,
  name: string,
): Promise<{ id: string; name: string; isDefault: boolean }> {
  const res = await client.post("/applications", { name });
  if (res.status() !== 201) {
    throw new Error(`Create application failed (${res.status()}): ${await res.text()}`);
  }
  return res.json();
}

// ─── Agents (Packages) ─────────────────────────

export async function createAgent(
  client: ApiClient,
  scope: string,
  name: string,
): Promise<{ id: string }> {
  const manifest = {
    schemaVersion: "1.0",
    name: `${scope}/${name}`,
    displayName: `Test Agent ${name}`,
    version: "0.1.0",
    type: "agent",
    description: `E2E test agent ${name}`,
  };

  const res = await client.post("/packages/agents", {
    manifest,
    content: "You are a test agent.",
  });

  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`Create agent failed (${res.status()}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * Create an agent with a config schema — needed to test per-app config isolation.
 * `mergeWithDefaults` strips keys not present in the schema, so agents without
 * a config schema cannot store arbitrary config values.
 */
export async function createAgentWithConfig(
  client: ApiClient,
  scope: string,
  name: string,
  configProperties: Record<string, unknown>,
): Promise<{ id: string }> {
  const manifest = {
    schemaVersion: "1.0",
    name: `${scope}/${name}`,
    displayName: `Test Agent ${name}`,
    version: "0.1.0",
    type: "agent",
    description: `E2E test agent ${name}`,
    config: {
      schema: {
        type: "object",
        properties: configProperties,
      },
    },
  };

  const res = await client.post("/packages/agents", {
    manifest,
    content: "You are a test agent.",
  });

  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`Create agent failed (${res.status()}): ${await res.text()}`);
  }
  return res.json();
}

// ─── Webhooks ───────────────────────────────────

export async function createWebhook(
  client: ApiClient,
  overrides: {
    url?: string;
    events?: string[];
    level?: "org" | "application";
    applicationId?: string;
  } = {},
): Promise<{ id: string; url: string; secret: string }> {
  const res = await client.post("/webhooks", {
    level: overrides.level ?? "org",
    url: overrides.url ?? "https://example.com/hook",
    events: overrides.events ?? ["run.success"],
    ...(overrides.applicationId ? { applicationId: overrides.applicationId } : {}),
  });

  if (res.status() !== 201) {
    throw new Error(`Create webhook failed (${res.status()}): ${await res.text()}`);
  }
  return res.json();
}

// ─── End-Users ──────────────────────────────────

export async function createEndUser(
  client: ApiClient,
  overrides: { name?: string; email?: string; externalId?: string } = {},
): Promise<{ id: string; name: string | null; email: string | null }> {
  const res = await client.post("/end-users", {
    name: overrides.name ?? `EU ${Date.now()}`,
    email: overrides.email,
    externalId: overrides.externalId,
  });

  if (res.status() !== 201) {
    throw new Error(`Create end-user failed (${res.status()}): ${await res.text()}`);
  }
  return res.json();
}

// ─── API Keys ───────────────────────────────────

export async function createApiKey(
  client: ApiClient,
  name?: string,
): Promise<{ id: string; key: string; name: string }> {
  const res = await client.post("/api-keys", {
    name: name ?? `E2E Key ${Date.now()}`,
  });

  if (res.status() !== 201) {
    throw new Error(`Create API key failed (${res.status()}): ${await res.text()}`);
  }
  return res.json();
}

// ─── Schedules ──────────────────────────────────

export async function createSchedule(
  client: ApiClient,
  agentScope: string,
  agentName: string,
  profileId: string,
): Promise<{ id: string }> {
  const res = await client.post(`/agents/${agentScope}/${agentName}/schedules`, {
    connectionProfileId: profileId,
    cronExpression: "0 * * * *",
    name: `E2E Schedule ${Date.now()}`,
  });

  if (res.status() !== 201) {
    throw new Error(`Create schedule failed (${res.status()}): ${await res.text()}`);
  }
  return res.json();
}

// ─── Connection Profiles ────────────────────────

export async function createConnectionProfile(
  request: APIRequestContext,
  cookie: string,
  orgId: string,
): Promise<{ id: string }> {
  const res = await request.post("/api/connection-profiles", {
    headers: {
      Cookie: cookie,
      "X-Org-Id": orgId,
      "Content-Type": "application/json",
    },
    data: { name: `E2E Profile ${Date.now()}` },
  });

  if (res.status() !== 201) {
    throw new Error(`Create profile failed (${res.status()}): ${await res.text()}`);
  }
  const body = await res.json();
  return body.profile ?? body;
}

// ─── Application Packages (install/uninstall) ───

export async function installPackageInApp(
  client: ApiClient | ReturnType<typeof createOrgOnlyClient>,
  appId: string,
  packageId: string,
): Promise<void> {
  const res = await client.post(`/applications/${appId}/packages`, { packageId });
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`Install package failed (${res.status()}): ${await res.text()}`);
  }
}

export async function uninstallPackageFromApp(
  client: ApiClient | ReturnType<typeof createOrgOnlyClient>,
  appId: string,
  scope: string,
  name: string,
): Promise<void> {
  const res = await client.delete(`/applications/${appId}/packages/${scope}/${name}`);
  if (res.status() !== 204 && res.status() !== 200) {
    throw new Error(`Uninstall package failed (${res.status()}): ${await res.text()}`);
  }
}
