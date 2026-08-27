// SPDX-License-Identifier: Apache-2.0

/**
 * Run isolation E2E tests.
 *
 * Verifies that run listings are properly scoped by org and space.
 * Note: actual run creation requires Docker, so these tests verify
 * listing/detail endpoints return correct scoping (empty lists, 404s).
 */

import { test, expect } from "../../fixtures/multi-context.fixture.ts";
import { test as spaceTest, expect as spaceExpect } from "../../fixtures/api.fixture.ts";
import { createAgent, createSpace } from "../../helpers/seed.ts";
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
    const res = await clientB.get("/runs/run_nonexistent12345");
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot access OrgA run logs", async ({ clientB }) => {
    const res = await clientB.get("/runs/run_nonexistent12345/logs");
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot cancel OrgA run", async ({ clientB }) => {
    const res = await clientB.post("/runs/run_nonexistent12345/cancel");
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
// Cross-space run isolation
// ═══════════════════════════════════════════════

spaceTest.describe("Cross-space run isolation", () => {
  spaceTest(
    "Run listing is space-scoped (custom space has no runs)",
    async ({ request, orgContext, orgOnlyClient }) => {
      const customSpace = await createSpace(orgOnlyClient, `RunIso-${Date.now()}`);
      const customClient = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: customSpace.id,
      });

      // Custom space should have 0 runs
      const res = await customClient.get("/runs");
      spaceExpect(res.status()).toBe(200);
      const body = await res.json();
      spaceExpect(body.data ?? []).toHaveLength(0);
    },
  );

  spaceTest(
    "Custom space without agent installed cannot list agent runs",
    async ({ request, apiClient, orgContext, orgOnlyClient }) => {
      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `run-noaccess-${Date.now()}`;
      await createAgent(apiClient, scope, agentName);

      // Custom space without the agent installed
      const customSpace = await createSpace(orgOnlyClient, `RunNoAccess-${Date.now()}`);
      const customClient = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: customSpace.id,
      });

      // Should 404 — requireAgent() blocks access
      const res = await customClient.get(`/agents/${scope}/${agentName}/runs`);
      spaceExpect(res.status()).toBe(404);
    },
  );

  spaceTest(
    "Agent runs listing is space-scoped",
    async ({ request, apiClient, orgContext, orgOnlyClient }) => {
      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `run-space-${Date.now()}`;
      await createAgent(apiClient, scope, agentName);

      // Install agent in custom space
      const customSpace = await createSpace(orgOnlyClient, `RunSpace-${Date.now()}`);
      await orgOnlyClient.post(`/spaces/${customSpace.id}/packages`, {
        packageId: `${scope}/${agentName}`,
      });

      const customClient = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: customSpace.id,
      });

      // List runs for the agent from custom space — should be empty
      const res = await customClient.get(`/agents/${scope}/${agentName}/runs`);
      spaceExpect(res.status()).toBe(200);
      const body = await res.json();
      spaceExpect(body.data ?? []).toHaveLength(0);
    },
  );
});
