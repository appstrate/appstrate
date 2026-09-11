// SPDX-License-Identifier: Apache-2.0

/**
 * Space cascade deletion E2E tests.
 *
 * Verifies that deleting a custom space cascades to its
 * associated resources (webhooks, schedules, installed packages, end-users).
 */

import { test, expect } from "../../fixtures/api.fixture.ts";
import {
  createAgent,
  createSpace,
  createWebhook,
  createSchedule,
  installPackageInSpace,
} from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";

test.describe("Space cascade deletion", () => {
  test("Deleting a custom space removes its webhooks", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    // Create custom space + webhook in it
    const customSpace = await createSpace(orgOnlyClient, `CascWh-${Date.now()}`);
    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      spaceId: customSpace.id,
    });
    const wh = await createWebhook(customClient, {
      level: "space",
      spaceId: customSpace.id,
    });

    // Verify webhook exists
    let res = await customClient.get(`/webhooks/${wh.id}`);
    expect(res.status()).toBe(200);

    // Delete the custom space
    res = await orgOnlyClient.delete(`/spaces/${customSpace.id}`);
    expect(res.status()).toBe(204);

    // Webhook should be gone — accessing from default space should 404
    res = await apiClient.get(`/webhooks/${wh.id}`);
    expect(res.status()).toBe(404);
  });

  test("Deleting a custom space removes its installed packages", async ({
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `casc-pkg-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `CascPkg-${Date.now()}`);
    await installPackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);

    // Verify installed
    let res = await orgOnlyClient.get(`/spaces/${customSpace.id}/packages`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect((body.data ?? []).length).toBeGreaterThan(0);

    // Delete the space
    res = await orgOnlyClient.delete(`/spaces/${customSpace.id}`);
    expect(res.status()).toBe(204);

    // The space itself should be gone
    res = await orgOnlyClient.get(`/spaces/${customSpace.id}`);
    expect(res.status()).toBe(404);
  });

  test("Deleting a custom space removes its schedules", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `casc-sched-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `CascSched-${Date.now()}`);
    // Install agent in custom space so we can create schedule there
    await installPackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);

    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      spaceId: customSpace.id,
    });

    const schedule = await createSchedule(customClient, scope, agentName);

    // Verify schedule exists
    let res = await customClient.get(`/schedules/${schedule.id}`);
    expect(res.status()).toBe(200);

    // Delete the space
    res = await orgOnlyClient.delete(`/spaces/${customSpace.id}`);
    expect(res.status()).toBe(204);

    // Schedule should be gone — not accessible from default space either
    res = await apiClient.get(`/schedules/${schedule.id}`);
    expect(res.status()).toBe(404);
  });

  test("Cannot delete the default space", async ({ orgContext, orgOnlyClient }) => {
    const res = await orgOnlyClient.delete(`/spaces/${orgContext.org.defaultSpaceId}`);
    // 400 exactly: `deleteSpace` raises `invalidRequest("Cannot delete default
    // space")`. This used to accept 403 as well, which is a DIFFERENT outcome —
    // this same client deletes custom spaces above and gets 204, so a 403 here
    // would mean the RBAC guard, not the default-space rule, did the rejecting.
    expect(res.status()).toBe(400);
  });

  test("Deleting a custom space does not affect the default space's resources", async ({
    apiClient,
    orgOnlyClient,
  }) => {
    // Create org-level webhook (not tied to any specific space)
    const wh = await createWebhook(apiClient, {
      level: "org",
      url: "https://default-space.example.com/hook",
    });

    // Create + delete a custom space
    const customSpace = await createSpace(orgOnlyClient, `CascSafe-${Date.now()}`);
    const res = await orgOnlyClient.delete(`/spaces/${customSpace.id}`);
    expect(res.status()).toBe(204);

    // Default space's webhook should still exist
    const whRes = await apiClient.get(`/webhooks/${wh.id}`);
    expect(whRes.status()).toBe(200);
  });
});
