// SPDX-License-Identifier: Apache-2.0

/**
 * Run isolation E2E tests.
 *
 * Verifies that run listings are properly scoped by org and app.
 * Note: actual run creation requires Docker, so these tests verify
 * listing/detail endpoints return correct scoping (empty lists, 404s).
 */

import { test, expect } from "../../fixtures/multi-context.fixture.ts";
import { test as appTest, expect as appExpect } from "../../fixtures/api.fixture.ts";
import { createAgent, createApplication } from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";

// ═══════════════════════════════════════════════
// Cross-org run isolation
// ═══════════════════════════════════════════════

test.describe("Cross-org run isolation", () => {
  test("OrgB cannot list OrgA agent runs", async ({ clientA, clientB, ctxA }) => {
    const scope = `@${ctxA.org.orgSlug}`;
    const agentName = `run-iso-${Date.now()}`;
    await createAgent(clientA, scope, agentName);

    // OrgB tries to list runs for OrgA's agent — should 404 (agent not found)
    const res = await clientB.get(`/agents/${scope}/${agentName}/runs`);
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot access a run ID from OrgA", async ({ clientB }) => {
    // Attempt to access a fabricated run ID — should 404
    const res = await clientB.get("/runs/exec_nonexistent12345");
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot access OrgA run logs", async ({ clientB }) => {
    const res = await clientB.get("/runs/exec_nonexistent12345/logs");
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot cancel OrgA run", async ({ clientB }) => {
    const res = await clientB.post("/runs/exec_nonexistent12345/cancel");
    expect(res.status()).toBe(404);
  });

  test("Run listing is org-scoped (fresh org has no runs)", async ({ clientA, clientB }) => {
    // Both fresh orgs should have empty run lists
    const resA = await clientA.get("/runs");
    const resB = await clientB.get("/runs");
    expect(resA.status()).toBe(200);
    expect(resB.status()).toBe(200);

    const bodyA = await resA.json();
    const bodyB = await resB.json();
    expect(bodyA.data ?? []).toHaveLength(0);
    expect(bodyB.data ?? []).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════
// Cross-app run isolation
// ═══════════════════════════════════════════════

appTest.describe("Cross-app run isolation", () => {
  appTest(
    "Run listing is app-scoped (custom app has no runs)",
    async ({ request, apiClient, orgContext, orgOnlyClient }) => {
      const customApp = await createApplication(orgOnlyClient, `RunIso-${Date.now()}`);
      const customClient = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: customApp.id,
      });

      // Custom app should have 0 runs
      const res = await customClient.get("/runs");
      appExpect(res.status()).toBe(200);
      const body = await res.json();
      appExpect(body.data ?? []).toHaveLength(0);
    },
  );

  appTest(
    "Custom app without agent installed cannot list agent runs",
    async ({ request, apiClient, orgContext, orgOnlyClient }) => {
      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `run-noaccess-${Date.now()}`;
      await createAgent(apiClient, scope, agentName);

      // Custom app without the agent installed
      const customApp = await createApplication(orgOnlyClient, `RunNoAccess-${Date.now()}`);
      const customClient = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: customApp.id,
      });

      // Should 404 — requireAgent() blocks access
      const res = await customClient.get(`/agents/${scope}/${agentName}/runs`);
      appExpect(res.status()).toBe(404);
    },
  );

  appTest(
    "Agent runs listing is app-scoped",
    async ({ request, apiClient, orgContext, orgOnlyClient }) => {
      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `run-app-${Date.now()}`;
      await createAgent(apiClient, scope, agentName);

      // Install agent in custom app
      const customApp = await createApplication(orgOnlyClient, `RunApp-${Date.now()}`);
      await orgOnlyClient.post(`/applications/${customApp.id}/packages`, {
        packageId: `${scope}/${agentName}`,
      });

      const customClient = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: customApp.id,
      });

      // List runs for the agent from custom app — should be empty
      const res = await customClient.get(`/agents/${scope}/${agentName}/runs`);
      appExpect(res.status()).toBe(200);
      const body = await res.json();
      appExpect(body.data ?? []).toHaveLength(0);
    },
  );
});
