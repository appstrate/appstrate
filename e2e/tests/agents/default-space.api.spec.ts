// SPDX-License-Identifier: Apache-2.0

/**
 * Default space vs custom space access E2E tests.
 *
 * Verifies that the default space has implicit access to all org packages,
 * while custom spaces only see explicitly installed packages.
 * Also verifies per-space config isolation.
 */

import { test, expect } from "../../fixtures/api.fixture.ts";
import {
  createAgent,
  createAgentWithInputSchema,
  createSpace,
  installPackageInSpace,
  uninstallPackageFromSpace,
} from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";

test.describe("Default space vs custom space access", () => {
  test("Default space lists only auto-installed agents (created via its context)", async ({
    apiClient,
    orgContext,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    // Agents created via apiClient (default space context) are auto-installed in the default space
    await createAgent(apiClient, scope, `agent-def-1-${Date.now()}`);
    await createAgent(apiClient, scope, `agent-def-2-${Date.now()}`);
    await createAgent(apiClient, scope, `agent-def-3-${Date.now()}`);

    const res = await apiClient.get("/agents");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const orgAgents = (body.data ?? []).filter((a: { id: string }) => a.id.startsWith(scope));
    expect(orgAgents.length).toBeGreaterThanOrEqual(3);
  });

  test("Custom space lists only installed agents", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agent1Name = `agent-cust-1-${Date.now()}`;
    const agent2Name = `agent-cust-2-${Date.now()}`;
    const agent3Name = `agent-cust-3-${Date.now()}`;
    await createAgent(apiClient, scope, agent1Name);
    await createAgent(apiClient, scope, agent2Name);
    await createAgent(apiClient, scope, agent3Name);

    // Create custom space and install only agent1
    const customSpace = await createSpace(orgOnlyClient, `Custom-${Date.now()}`);
    await installPackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agent1Name}`);

    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      spaceId: customSpace.id,
    });

    const res = await customClient.get("/agents");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const agentIds = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(agentIds).toContain(`${scope}/${agent1Name}`);
    expect(agentIds).not.toContain(`${scope}/${agent2Name}`);
    expect(agentIds).not.toContain(`${scope}/${agent3Name}`);
  });

  test("Install agent makes it visible in custom space", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-install-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `Install-${Date.now()}`);
    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      spaceId: customSpace.id,
    });

    // Before install — not visible
    let res = await customClient.get("/agents");
    let body = await res.json();
    let ids = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(ids).not.toContain(`${scope}/${agentName}`);

    // Install
    await installPackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);

    // After install — visible
    res = await customClient.get("/agents");
    body = await res.json();
    ids = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(ids).toContain(`${scope}/${agentName}`);
  });

  test("Uninstall agent hides it from custom space", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-uninstall-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `Uninstall-${Date.now()}`);
    await installPackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);

    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      spaceId: customSpace.id,
    });

    // Before uninstall — visible
    let res = await customClient.get("/agents");
    let body = await res.json();
    let ids = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(ids).toContain(`${scope}/${agentName}`);

    // Uninstall
    await uninstallPackageFromSpace(orgOnlyClient, customSpace.id, scope, agentName);

    // After uninstall — gone
    res = await customClient.get("/agents");
    body = await res.json();
    ids = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(ids).not.toContain(`${scope}/${agentName}`);
  });

  test("Agent detail accessible from default space for auto-installed agent", async ({
    apiClient,
    orgContext,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-detail-def-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const res = await apiClient.get(`/packages/agents/${scope}/${agentName}`);
    expect(res.status()).toBe(200);
  });

  test("Agent detail NOT accessible from custom space when not installed", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-detail-cust-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `Detail-${Date.now()}`);
    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      spaceId: customSpace.id,
    });

    // Custom space without this agent installed should get 404
    const res = await customClient.get(`/packages/agents/${scope}/${agentName}`);
    expect(res.status()).toBe(404);
  });

  test("Stored input values are per-space (independent between default and custom space)", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-cfg-iso-${Date.now()}`;
    // Agent must declare an input schema — stored values are validated against it
    await createAgentWithInputSchema(apiClient, scope, agentName, {
      mode: { type: "string" },
    });

    const customSpace = await createSpace(orgOnlyClient, `CfgIso-${Date.now()}`);
    await installPackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);

    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      spaceId: customSpace.id,
    });

    // Store input values in the default space
    const resSetA = await apiClient.put(`/agents/${scope}/${agentName}/input-settings`, {
      values: { mode: "default-space-value" },
      locked_fields: [],
    });
    expect(resSetA.status()).toBe(200);

    // Store different values in the custom space
    const resSetB = await customClient.put(`/agents/${scope}/${agentName}/input-settings`, {
      values: { mode: "custom-space-value" },
      locked_fields: [],
    });
    expect(resSetB.status()).toBe(200);

    // Read back via agent detail — each space should see its own values
    const resDetailA = await apiClient.get(`/packages/agents/${scope}/${agentName}`);
    const resDetailB = await customClient.get(`/packages/agents/${scope}/${agentName}`);
    expect(resDetailA.status()).toBe(200);
    expect(resDetailB.status()).toBe(200);

    const detailA = await resDetailA.json();
    const detailB = await resDetailB.json();
    expect(detailA.input?.values?.mode).toBe("default-space-value");
    expect(detailB.input?.values?.mode).toBe("custom-space-value");
  });

  test("Installed packages list is per-space", async ({ apiClient, orgContext, orgOnlyClient }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-pkg-list-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `PkgList-${Date.now()}`);
    await installPackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);

    // Custom space's installed packages should contain the agent
    const res = await orgOnlyClient.get(`/spaces/${customSpace.id}/packages?type=agent`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = (body.data ?? []).map((p: { packageId: string }) => p.packageId);
    expect(ids).toContain(`${scope}/${agentName}`);
  });

  test("Cannot install the same package twice in a custom space", async ({
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-dup-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `DupInstall-${Date.now()}`);
    await installPackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);

    // Second install should conflict
    const res = await orgOnlyClient.post(`/spaces/${customSpace.id}/packages`, {
      packageId: `${scope}/${agentName}`,
    });
    expect(res.status()).toBe(409);
  });
});
