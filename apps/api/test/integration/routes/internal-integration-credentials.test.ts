// SPDX-License-Identifier: Apache-2.0

/**
 * GET /internal/integration-credentials/:scope/:name (+ /refresh) —
 * fail-closed authorization on the most credential-sensitive endpoint
 * in the platform.
 *
 * The sidecar fetches live decrypted credentials here to inject into
 * outbound integration calls (the MITM credential boundary). The route
 * is authorised by the per-run Bearer token AND
 * `assertAgentDeclaresIntegration`, which verifies the running agent
 * declares the integration as a dependency AND it is installed in the
 * run's application. A leaked run token must not be able to enumerate
 * arbitrary integration secrets across the org.
 *
 * Mirrors the structure of `internal-mcp-server-bundle.test.ts`. Deep
 * OAuth refresh semantics (invalid_grant → 410, transient → 502,
 * scope-shrink behaviour) live in the service-level test
 * `services/integration-credentials-resolver.test.ts`. This file pins
 * the HTTP route boundary: auth, dep, install, response shape.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedPackage } from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import { encryptCredentials } from "@appstrate/connect";
import { integrationConnections, runs } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const app = getTestApp();

const AGENT = "@credsorg/test-agent";
const INTEGRATION = "@credsorg/svc";
const OTHER_INTEGRATION = "@credsorg/other-svc";
const MCP_SERVER = "@credsorg/svc-server";

function buildAgentManifest(declaredIntegrations: string[]): Record<string, unknown> {
  const deps: Record<string, string> = {};
  const sel: Record<string, { tools?: string[] }> = {};
  for (const id of declaredIntegrations) {
    deps[id] = "^1.0.0";
    sel[id] = { tools: ["search"] };
  }
  return {
    name: AGENT,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    display_name: "Creds Test Agent",
    dependencies: { integrations: deps },
    integrations: sel,
  };
}

function buildIntegrationManifest(id: string) {
  return localIntegrationManifest({
    name: id,
    serverName: MCP_SERVER,
    version: "1.0.0",
    auths: {
      primary: {
        type: "api_key",
        authorizedUris: ["https://api.example.com/**"],
        credentialFields: ["api_key"],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "api_key",
        }),
      },
    },
    tools_policy: { search: {} },
  });
}

describe("GET /internal/integration-credentials/:scope/:name", () => {
  let ctx: TestContext;
  let runId: string;
  let token: string;

  async function seedIntegration(id: string, installed: boolean) {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(id),
    });
    if (installed) {
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id);
    }
  }

  /** Seed an api_key connection for the test user on the given integration. */
  async function seedConnection(integrationId: string) {
    const ciphertext = encryptCredentials({ api_key: "live-secret-value" });
    await db.insert(integrationConnections).values({
      integrationId: integrationId,
      authKey: "primary",
      accountId: "acct-test",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: ciphertext,
      scopesGranted: [],
    });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "credsorg" });

    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION]),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);

    const run = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "running",
    });
    runId = run.id;
    token = signRunToken(runId);
  });

  // ─── Auth boundary ─────────────────────────────────────

  it("returns 401 without a run token", async () => {
    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`);
    expect(res.status).toBe(401);
  });

  it("returns 401 with a forged run token", async () => {
    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  // ─── Dep-and-install gate ──────────────────────────────

  it("DENY: 404 when the integration is NOT declared by the running agent", async () => {
    // OTHER_INTEGRATION exists + is installed, but the agent doesn't depend on it.
    // A leaked run token from AGENT must not be able to enumerate OTHER's creds.
    await seedIntegration(INTEGRATION, true);
    await seedConnection(INTEGRATION);
    await seedIntegration(OTHER_INTEGRATION, true);
    await seedConnection(OTHER_INTEGRATION);

    const res = await app.request(`/internal/integration-credentials/${OTHER_INTEGRATION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    // ApiError serialises detail/title with the integration id mentioned.
    expect(JSON.stringify(body)).toMatch(/not a dependency/i);
  });

  it("DENY: 404 when the integration is declared but NOT installed in the app", async () => {
    // The dep is declared, but `application_packages` row is absent.
    // The gate refuses — install is a separate authorization layer.
    await seedIntegration(INTEGRATION, false);
    await seedConnection(INTEGRATION);

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/not installed in this application/i);
  });

  // ─── Happy path ────────────────────────────────────────

  it("ALLOW: returns the live credentials payload for a declared + installed integration", async () => {
    await seedIntegration(INTEGRATION, true);
    await seedConnection(INTEGRATION);

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auths: Array<{ auth_key: string; auth_type: string; fields: Record<string, string> }>;
      delivery_plans: Record<string, unknown>;
    };
    expect(body.auths).toHaveLength(1);
    expect(body.auths[0]!.auth_key).toBe("primary");
    expect(body.auths[0]!.auth_type).toBe("api_key");
    // Decrypted credential payload reaches the sidecar — this IS the surface.
    expect(body.auths[0]!.fields.api_key).toBe("live-secret-value");
    // Delivery plan derived from manifest.auths.primary.delivery.http.
    expect(body.delivery_plans.primary).toBeDefined();
  });

  it("ALLOW: returns empty auths when the integration declares no auths", async () => {
    // Edge case: an integration manifest can ship without auths (purely
    // public). The route should return an empty payload rather than 404,
    // because the dep-and-install gate is what authorises the call.
    // We test the route shape stays consistent.
    await seedIntegration(INTEGRATION, true);
    // No connection seeded — the actor has nothing for this integration.
    // The resolver returns the empty payload shape (auths=[]) — matches
    // production behaviour where no connection yet exists.

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auths: unknown[];
      delivery_plans: Record<string, unknown>;
    };
    expect(body.auths).toEqual([]);
    expect(body.delivery_plans).toEqual({});
  });
});

describe("POST /internal/integration-credentials/:scope/:name/refresh", () => {
  let ctx: TestContext;
  let runId: string;
  let token: string;

  async function seedIntegration(id: string, installed: boolean) {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(id),
    });
    if (installed) {
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id);
    }
  }

  async function seedConnection(integrationId: string) {
    const ciphertext = encryptCredentials({ api_key: "live-secret-value" });
    await db.insert(integrationConnections).values({
      integrationId: integrationId,
      authKey: "primary",
      accountId: "acct-test",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: ciphertext,
      scopesGranted: [],
    });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "refresh" });

    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION]),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);

    const run = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "running",
    });
    runId = run.id;
    token = signRunToken(runId);
  });

  // ─── Auth boundary (mirror of GET) ─────────────────────

  it("returns 401 without a run token", async () => {
    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}/refresh`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  // ─── Dep-and-install gate ──────────────────────────────

  it("DENY: 404 when the integration is NOT declared by the running agent", async () => {
    await seedIntegration(OTHER_INTEGRATION, true);
    await seedConnection(OTHER_INTEGRATION);

    const res = await app.request(
      `/internal/integration-credentials/${OTHER_INTEGRATION}/refresh`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(404);
  });

  it("DENY: 404 when the integration is declared but NOT installed in the app", async () => {
    await seedIntegration(INTEGRATION, false);
    await seedConnection(INTEGRATION);

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
  });

  // ─── Terminal on a non-OAuth auth (the unified flagging path) ──

  it("flags needsReconnection + records run metadata + 410 for a non-OAuth auth on a forced refresh", async () => {
    // A forced /refresh only happens after an upstream 401. A non-OAuth
    // (api_key) credential cannot be refreshed → it is dead → the route flags
    // the connection, stamps the run's degraded_integrations, and returns 410
    // (the sidecar maps that to "don't retry"). This is the single place a
    // terminal auth failure is recorded — no separate report endpoint.
    await seedIntegration(INTEGRATION, true);
    await seedConnection(INTEGRATION);

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(410);

    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION));
    expect(row!.needsReconnection).toBe(true);

    const [runRow] = await db.select().from(runs).where(eq(runs.id, runId));
    const meta = runRow!.metadata as { degraded_integrations?: string[] } | null;
    expect(meta?.degraded_integrations).toContain(INTEGRATION);
  });
});
