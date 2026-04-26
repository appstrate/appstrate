// SPDX-License-Identifier: Apache-2.0

/**
 * Default app vs custom app access E2E tests.
 *
 * Verifies that the default application has implicit access to all org packages,
 * while custom applications only see explicitly installed packages.
 * Also verifies per-app config isolation.
 */

import { test, expect } from "../../fixtures/api.fixture.ts";
import {
  createAgent,
  createAgentWithConfig,
  createApplication,
  installPackageInApp,
  uninstallPackageFromApp,
} from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";

test.describe("Default app vs custom app access", () => {
  test("Default app lists only auto-installed agents (created via its context)", async ({
    apiClient,
    orgContext,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    // Agents created via apiClient (default app context) are auto-installed in the default app
    await createAgent(apiClient, scope, `agent-def-1-${Date.now()}`);
    await createAgent(apiClient, scope, `agent-def-2-${Date.now()}`);
    await createAgent(apiClient, scope, `agent-def-3-${Date.now()}`);

    const res = await apiClient.get("/agents");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const orgAgents = (body.data ?? []).filter((a: { id: string }) => a.id.startsWith(scope));
    expect(orgAgents.length).toBeGreaterThanOrEqual(3);
  });

  test("Custom app lists only installed agents", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agent1Name = `agent-cust-1-${Date.now()}`;
    const agent2Name = `agent-cust-2-${Date.now()}`;
    const agent3Name = `agent-cust-3-${Date.now()}`;
    const agent1 = await createAgent(apiClient, scope, agent1Name);
    const agent2 = await createAgent(apiClient, scope, agent2Name);
    await createAgent(apiClient, scope, agent3Name);

    // Create custom app and install only agent1
    const customApp = await createApplication(orgOnlyClient, `Custom-${Date.now()}`);
    await installPackageInApp(orgOnlyClient, customApp.id, `${scope}/${agent1Name}`);

    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      appId: customApp.id,
    });

    const res = await customClient.get("/agents");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const agentIds = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(agentIds).toContain(`${scope}/${agent1Name}`);
    expect(agentIds).not.toContain(`${scope}/${agent2Name}`);
    expect(agentIds).not.toContain(`${scope}/${agent3Name}`);
  });

  test("Install agent makes it visible in custom app", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-install-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customApp = await createApplication(orgOnlyClient, `Install-${Date.now()}`);
    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      appId: customApp.id,
    });

    // Before install — not visible
    let res = await customClient.get("/agents");
    let body = await res.json();
    let ids = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(ids).not.toContain(`${scope}/${agentName}`);

    // Install
    await installPackageInApp(orgOnlyClient, customApp.id, `${scope}/${agentName}`);

    // After install — visible
    res = await customClient.get("/agents");
    body = await res.json();
    ids = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(ids).toContain(`${scope}/${agentName}`);
  });

  test("Uninstall agent hides it from custom app", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-uninstall-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customApp = await createApplication(orgOnlyClient, `Uninstall-${Date.now()}`);
    await installPackageInApp(orgOnlyClient, customApp.id, `${scope}/${agentName}`);

    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      appId: customApp.id,
    });

    // Before uninstall — visible
    let res = await customClient.get("/agents");
    let body = await res.json();
    let ids = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(ids).toContain(`${scope}/${agentName}`);

    // Uninstall
    await uninstallPackageFromApp(orgOnlyClient, customApp.id, scope, agentName);

    // After uninstall — gone
    res = await customClient.get("/agents");
    body = await res.json();
    ids = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(ids).not.toContain(`${scope}/${agentName}`);
  });

  test("Agent detail accessible from default app for auto-installed agent", async ({
    apiClient,
    orgContext,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-detail-def-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const res = await apiClient.get(`/packages/agents/${scope}/${agentName}`);
    expect(res.status()).toBe(200);
  });

  test("Agent detail NOT accessible from custom app when not installed", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-detail-cust-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customApp = await createApplication(orgOnlyClient, `Detail-${Date.now()}`);
    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      appId: customApp.id,
    });

    // Custom app without this agent installed should get 404
    const res = await customClient.get(`/packages/agents/${scope}/${agentName}`);
    expect(res.status()).toBe(404);
  });

  test("Config is per-app (independent between default and custom app)", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-cfg-iso-${Date.now()}`;
    // Agent must have a config schema — mergeWithDefaults strips keys not in schema
    await createAgentWithConfig(apiClient, scope, agentName, {
      mode: { type: "string" },
    });

    const customApp = await createApplication(orgOnlyClient, `CfgIso-${Date.now()}`);
    await installPackageInApp(orgOnlyClient, customApp.id, `${scope}/${agentName}`);

    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      appId: customApp.id,
    });

    // Set config in default app (body IS the config object, not wrapped)
    const resSetA = await apiClient.put(`/agents/${scope}/${agentName}/config`, {
      mode: "default-app-value",
    });
    expect(resSetA.status()).toBe(200);

    // Set different config in custom app
    const resSetB = await customClient.put(`/agents/${scope}/${agentName}/config`, {
      mode: "custom-app-value",
    });
    expect(resSetB.status()).toBe(200);

    // Read back via agent detail — each app should see its own config
    const resDetailA = await apiClient.get(`/packages/agents/${scope}/${agentName}`);
    const resDetailB = await customClient.get(`/packages/agents/${scope}/${agentName}`);
    expect(resDetailA.status()).toBe(200);
    expect(resDetailB.status()).toBe(200);

    const detailA = await resDetailA.json();
    const detailB = await resDetailB.json();
    expect(detailA.agent?.config?.current?.mode).toBe("default-app-value");
    expect(detailB.agent?.config?.current?.mode).toBe("custom-app-value");
  });

  test("Installed packages list is per-app", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-pkg-list-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customApp = await createApplication(orgOnlyClient, `PkgList-${Date.now()}`);
    await installPackageInApp(orgOnlyClient, customApp.id, `${scope}/${agentName}`);

    // Custom app's installed packages should contain the agent
    const res = await orgOnlyClient.get(`/applications/${customApp.id}/packages?type=agent`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = (body.data ?? []).map((p: { packageId: string }) => p.packageId);
    expect(ids).toContain(`${scope}/${agentName}`);
  });

  test("Cannot install the same package twice in a custom app", async ({
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-dup-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customApp = await createApplication(orgOnlyClient, `DupInstall-${Date.now()}`);
    await installPackageInApp(orgOnlyClient, customApp.id, `${scope}/${agentName}`);

    // Second install should conflict
    const res = await orgOnlyClient.post(`/applications/${customApp.id}/packages`, {
      packageId: `${scope}/${agentName}`,
    });
    expect(res.status()).toBe(409);
  });
});
