// SPDX-License-Identifier: Apache-2.0

/**
 * Default space vs custom space access E2E tests.
 *
 * Verifies that the default space has implicit access to all org packages,
 * while a custom space sees only what has been placed there.
 * Also verifies per-space config isolation.
 */

import { test, expect } from "../../fixtures/api.fixture.ts";
import {
  createAgent,
  createAgentWithInputSchema,
  createSpace,
  activatePackageInSpace,
  deactivatePackageInSpace,
} from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";

test.describe("Default space vs custom space access", () => {
  test("Default space lists the agents authored in it", async ({ apiClient, orgContext }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    // Creating a package activates it at its home, which is this space.
    await createAgent(apiClient, scope, `agent-def-1-${Date.now()}`);
    await createAgent(apiClient, scope, `agent-def-2-${Date.now()}`);
    await createAgent(apiClient, scope, `agent-def-3-${Date.now()}`);

    const res = await apiClient.get("/agents");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const orgAgents = (body.data ?? []).filter((a: { id: string }) => a.id.startsWith(scope));
    expect(orgAgents.length).toBeGreaterThanOrEqual(3);
  });

  test("Custom space lists only the agents placed there", async ({
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

    // Create a custom space and place only agent1 in it
    const customSpace = await createSpace(orgOnlyClient, `Custom-${Date.now()}`);
    await activatePackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agent1Name}`);

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

  test("Activating an agent makes it visible in a custom space", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-activate-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `Activate-${Date.now()}`);
    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      spaceId: customSpace.id,
    });

    // Before — not placed here, so not visible
    let res = await customClient.get("/agents");
    let body = await res.json();
    let ids = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(ids).not.toContain(`${scope}/${agentName}`);

    // Activate: the one door, which also shares it out of its home
    await activatePackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);

    // After — visible
    res = await customClient.get("/agents");
    body = await res.json();
    ids = (body.data ?? []).map((a: { id: string }) => a.id);
    expect(ids).toContain(`${scope}/${agentName}`);
  });

  test("Deactivating an agent stops it running there without hiding it", async ({
    request,
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    // Listing and running are two different rules. The index follows the
    // PLACEMENT (the activation shared the agent into this space, and a share
    // is not revoked by a switch), so the row stays and says it is off; the
    // launch routes follow the activation, so they refuse.
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-deactivate-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `Deactivate-${Date.now()}`);
    await activatePackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);

    const customClient = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      spaceId: customSpace.id,
    });

    const listed = async () => {
      const res = await customClient.get("/agents");
      const body = await res.json();
      return (body.data ?? []).find((a: { id: string }) => a.id === `${scope}/${agentName}`) as
        { id: string; active: boolean } | undefined;
    };

    expect((await listed())?.active).toBe(true);

    await deactivatePackageInSpace(orgOnlyClient, customSpace.id, scope, agentName);

    expect((await listed())?.active).toBe(false);
    // Reading is not running, and the switch does not touch the first: the
    // agent loads, its model reads back, and the readiness read REPORTS the
    // blockage inside a 200 instead of hiding the panel that explains it.
    for (const read of [
      await customClient.get(`/packages/agents/${scope}/${agentName}`),
      await customClient.get(`/agents/${scope}/${agentName}/model`),
      await customClient.get(`/agents/${scope}/${agentName}/connection-readiness`),
    ]) {
      expect(read.status(), await read.text()).toBe(200);
    }
    const readiness = await customClient.get(`/agents/${scope}/${agentName}/connection-readiness`);
    const readinessBody = await readiness.json();
    expect(readinessBody.blocks_run).toBe(true);
    expect((readinessBody.errors as Array<{ code: string }>).map((error) => error.code)).toContain(
      "agent_not_active",
    );
    // The execution doors add `requireActiveAgent()` behind that same lookup, so
    // they answer with one voice: an agent this space READS but has switched
    // off is named apart from one it cannot see at all. Both are 404 — the
    // status never leaks the catalogue — but only this one carries the cure.
    for (const refusal of [
      await customClient.post(`/agents/${scope}/${agentName}/run`, {}),
      await customClient.get(`/agents/${scope}/${agentName}/bundle`),
    ]) {
      expect(refusal.status(), await refusal.text()).toBe(404);
      const body = await refusal.json();
      expect(body.code).toBe("agent_not_active_in_space");
      expect(body.detail).toContain("but not active there");
      expect(body.detail).toContain(`POST /api/spaces/${customSpace.id}/packages`);
    }
    // CONTROL: an agent this space holds no placement for stays opaque — the
    // named code is about the SWITCH, never about existence.
    const unknown = await customClient.post(`/agents/${scope}/no-such-agent-here/run`, {});
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).code).toBe("agent_not_found");

    // And back on, through the same door: the settings the row carried are
    // still there because the row never went away.
    await activatePackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);
    expect((await listed())?.active).toBe(true);
  });

  test("Agent detail accessible from the space that homes the agent", async ({
    apiClient,
    orgContext,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-detail-def-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const res = await apiClient.get(`/packages/agents/${scope}/${agentName}`);
    expect(res.status()).toBe(200);
  });

  test("Agent detail NOT accessible from a space the agent is not placed in", async ({
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

    // A custom space the agent was never placed in should get 404
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
    await activatePackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);

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

  test("The list of packages placed in a space is per-space", async ({
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-pkg-list-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `PkgList-${Date.now()}`);
    await activatePackageInSpace(orgOnlyClient, customSpace.id, `${scope}/${agentName}`);

    // The custom space's package list should contain the agent
    const res = await orgOnlyClient.get(`/spaces/${customSpace.id}/packages?type=agent`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = (body.data ?? []).map((p: { packageId: string }) => p.packageId);
    expect(ids).toContain(`${scope}/${agentName}`);
  });

  test("Activating the same package twice is the same state, not a conflict", async ({
    apiClient,
    orgContext,
    orgOnlyClient,
  }) => {
    // "Make it active here" is a state, so saying it twice says nothing new:
    // the first call creates the placement (201), the second finds it and
    // answers 200 with the same resource.
    const scope = `@${orgContext.org.orgSlug}`;
    const agentName = `agent-dup-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `DupActivate-${Date.now()}`);
    const first = await orgOnlyClient.post(`/spaces/${customSpace.id}/packages`, {
      packageId: `${scope}/${agentName}`,
    });
    expect(first.status(), await first.text()).toBe(201);

    const again = await orgOnlyClient.post(`/spaces/${customSpace.id}/packages`, {
      packageId: `${scope}/${agentName}`,
    });
    expect(again.status(), await again.text()).toBe(200);
  });
});
