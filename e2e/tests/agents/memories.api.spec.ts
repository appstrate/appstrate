// SPDX-License-Identifier: Apache-2.0

/**
 * Agent memory isolation E2E tests.
 *
 * Verifies that memories are properly scoped by app:
 * - Memories listed from AppA are not visible from AppB
 * - Memory deletion from AppB cannot affect AppA
 */

import { test, expect } from "../../fixtures/api.fixture.ts";
import { createAgent, createApplication, installPackageInApp } from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";

test.describe("Agent memory isolation", () => {
  // Note: Memories are created by the agent runtime (no POST API).
  // We can't seed memories in E2E, so cross-app data isolation is tested
  // via requireAgent() blocking access (tests below).
  // Full data isolation is covered by integration tests with seeded DB rows.

  test("Installed agent memories endpoint returns 200 from both apps", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `mem-iso-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    // Create custom app and install agent
    const customApp = await createApplication(orgOnlyClient, `MemIso-${Date.now()}`);
    await installPackageInApp(orgOnlyClient, customApp.id, `${scope}/${agentName}`);

    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      appId: customApp.id,
    });

    // Both apps with the agent installed can access the memories endpoint
    const resA = await apiClient.get(`/agents/${scope}/${agentName}/memories`);
    const resB = await customClient.get(`/agents/${scope}/${agentName}/memories`);
    expect(resA.status()).toBe(200);
    expect(resB.status()).toBe(200);
  });

  test("Custom app without agent installed cannot access memories", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `mem-noinstall-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    // Custom app without the agent installed
    const customApp = await createApplication(orgOnlyClient, `MemNo-${Date.now()}`);
    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      appId: customApp.id,
    });

    // Should 404 — requireAgent() checks app access
    const res = await customClient.get(`/agents/${scope}/${agentName}/memories`);
    expect(res.status()).toBe(404);
  });

  test("Custom app without agent installed cannot delete memories", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `mem-nodel-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customApp = await createApplication(orgOnlyClient, `MemNoDel-${Date.now()}`);
    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      appId: customApp.id,
    });

    // Should 404 — requireAgent() blocks access
    const res = await customClient.delete(`/agents/${scope}/${agentName}/memories`);
    expect(res.status()).toBe(404);
  });
});

// Cross-org memory isolation is implicitly covered by agent isolation
// (requireAgent uses getPackageWithAccess which checks org + app)
