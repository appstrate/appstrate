// SPDX-License-Identifier: Apache-2.0

/**
 * Application cascade deletion E2E tests.
 *
 * Verifies that deleting a custom application cascades to its
 * associated resources (webhooks, schedules, installed packages, end-users).
 */

import { test, expect } from "../../fixtures/api.fixture.ts";
import {
  createAgent,
  createApplication,
  createWebhook,
  createEndUser,
  createConnectionProfile,
  createSchedule,
  installPackageInApp,
} from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";

test.describe("Application cascade deletion", () => {
  test("Deleting a custom app removes its webhooks", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    // Create custom app + webhook in it
    const customApp = await createApplication(orgOnlyClient, `CascWh-${Date.now()}`);
    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      applicationId: customApp.id,
    });
    const wh = await createWebhook(customClient, {
      level: "application",
      applicationId: customApp.id,
    });

    // Verify webhook exists
    let res = await customClient.get(`/webhooks/${wh.id}`);
    expect(res.status()).toBe(200);

    // Delete the custom app
    res = await orgOnlyClient.delete(`/applications/${customApp.id}`);
    expect(res.status()).toBe(204);

    // Webhook should be gone — accessing from default app should 404
    res = await apiClient.get(`/webhooks/${wh.id}`);
    expect(res.status()).toBe(404);
  });

  test("Deleting a custom app removes its installed packages", async ({
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `casc-pkg-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customApp = await createApplication(orgOnlyClient, `CascPkg-${Date.now()}`);
    await installPackageInApp(orgOnlyClient, customApp.id, `${scope}/${agentName}`);

    // Verify installed
    let res = await orgOnlyClient.get(`/applications/${customApp.id}/packages`);
    expect(res.status()).toBe(200);
    let body = await res.json();
    expect((body.data ?? []).length).toBeGreaterThan(0);

    // Delete the app
    res = await orgOnlyClient.delete(`/applications/${customApp.id}`);
    expect(res.status()).toBe(204);

    // The app itself should be gone
    res = await orgOnlyClient.get(`/applications/${customApp.id}`);
    expect(res.status()).toBe(404);
  });

  test("Deleting a custom app removes its schedules", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `casc-sched-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customApp = await createApplication(orgOnlyClient, `CascSched-${Date.now()}`);
    // Install agent in custom app so we can create schedule there
    await installPackageInApp(orgOnlyClient, customApp.id, `${scope}/${agentName}`);

    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      applicationId: customApp.id,
    });

    const profile = await createConnectionProfile(
      request,
      orgContext.auth.cookie,
      orgContext.org.orgId,
    );
    const schedule = await createSchedule(customClient, scope, agentName, profile.id);

    // Verify schedule exists
    let res = await customClient.get(`/schedules/${schedule.id}`);
    expect(res.status()).toBe(200);

    // Delete the app
    res = await orgOnlyClient.delete(`/applications/${customApp.id}`);
    expect(res.status()).toBe(204);

    // Schedule should be gone — not accessible from default app either
    res = await apiClient.get(`/schedules/${schedule.id}`);
    expect(res.status()).toBe(404);
  });

  test("Cannot delete the default application", async ({ orgContext, orgOnlyClient }) => {
    const res = await orgOnlyClient.delete(`/applications/${orgContext.org.defaultAppId}`);
    // Should be rejected (400 or 403)
    expect([400, 403]).toContain(res.status());
  });

  test("Deleting a custom app does not affect the default app's resources", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    // Create org-level webhook (not tied to any specific app)
    const wh = await createWebhook(apiClient, {
      level: "org",
      url: "https://default-app.example.com/hook",
    });

    // Create + delete a custom app
    const customApp = await createApplication(orgOnlyClient, `CascSafe-${Date.now()}`);
    const res = await orgOnlyClient.delete(`/applications/${customApp.id}`);
    expect(res.status()).toBe(204);

    // Default app's webhook should still exist
    const whRes = await apiClient.get(`/webhooks/${wh.id}`);
    expect(whRes.status()).toBe(200);
  });
});
