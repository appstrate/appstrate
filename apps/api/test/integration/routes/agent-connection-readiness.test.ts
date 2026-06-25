// SPDX-License-Identifier: Apache-2.0

/**
 * GET /api/agents/:scope/:name/connection-readiness — bulk integration
 * connection readiness for an agent.
 *
 * Single source of truth behind the launch badge, the Connexions tab pickers,
 * and the pre-run check. The authoritative invariant asserted here:
 *
 *   body.blocks_run === true  ⇔  POST /api/agents/:scope/:name/run → 412
 *
 * plus per-integration `run_blocking` flags and the management `resolution`
 * DTO for every declared integration (even inert ones).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackage } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const AGENT = "@rdyorg/agent";
const INTEGRATION = "@rdyorg/svc";
const MCP_SERVER = "@rdyorg/svc-server";

function buildAgentManifest(integrations: string[], withTools: boolean): Record<string, unknown> {
  const deps: Record<string, string> = {};
  const config: Record<string, { tools: string[] }> = {};
  for (const id of integrations) {
    deps[id] = "^1.0.0";
    if (withTools) config[id] = { tools: ["search"] };
  }
  return {
    name: AGENT,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: "Readiness Agent",
    dependencies: { integrations: deps },
    integrations_configuration: config,
  };
}

function buildIntegrationManifest(id: string, required: boolean) {
  const m = localIntegrationManifest({
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
  if (required) {
    (m as unknown as { auths: { primary: Record<string, unknown> } }).auths.primary._meta = {
      "dev.appstrate/auth": { required: true },
    };
  }
  return m;
}

interface ReadinessResolution {
  status: string;
  resolved_connection_id: string | null;
}
interface ReadinessBody {
  blocks_run: boolean;
  errors: Array<{ field: string; code: string }>;
  integrations: Array<{
    integration_id: string;
    run_blocking: boolean;
    resolution: ReadinessResolution;
  }>;
}

describe("GET /api/agents/:scope/:name/connection-readiness", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "rdyorg" });
  });

  async function seedAgentWith(manifest: Record<string, unknown>) {
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: manifest,
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
  }

  async function seedIntegration(required: boolean) {
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(INTEGRATION, required),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, INTEGRATION);
  }

  async function seedConnection() {
    await db.insert(integrationConnections).values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: "acct-rdy",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentials({ api_key: "secret-value" }),
      scopesGranted: [],
    });
  }

  function getReadiness() {
    return app.request(`/api/agents/${AGENT}/connection-readiness`, {
      method: "GET",
      headers: authHeaders(ctx),
    });
  }

  function postRun() {
    return app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  it("active integration with no connection → blocks_run + run_blocking, and run 412s (parity)", async () => {
    await seedAgentWith(buildAgentManifest([INTEGRATION], true));
    await seedIntegration(false);

    const res = await getReadiness();
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadinessBody;

    expect(body.blocks_run).toBe(true);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.field).toBe(`integrations.${INTEGRATION}`);
    expect(body.errors[0]!.code).toBe("not_connected");

    const integ = body.integrations.find((i) => i.integration_id === INTEGRATION);
    expect(integ?.run_blocking).toBe(true);
    expect(integ?.resolution.status).toBe("none");

    // Parity: the run gate rejects with 412.
    expect((await postRun()).status).toBe(412);
  });

  it("inert OPTIONAL integration (no tools, not required) → present but not blocking", async () => {
    await seedAgentWith(buildAgentManifest([INTEGRATION], false));
    await seedIntegration(false);

    const body = (await (await getReadiness()).json()) as ReadinessBody;
    expect(body.blocks_run).toBe(false);
    expect(body.errors).toHaveLength(0);
    const integ = body.integrations.find((i) => i.integration_id === INTEGRATION);
    expect(integ).toBeDefined();
    expect(integ!.run_blocking).toBe(false);
  });

  it("inert REQUIRED integration (no tools, required auth) → blocks_run + run 412s (parity)", async () => {
    await seedAgentWith(buildAgentManifest([INTEGRATION], false));
    await seedIntegration(true);

    const body = (await (await getReadiness()).json()) as ReadinessBody;
    expect(body.blocks_run).toBe(true);
    const integ = body.integrations.find((i) => i.integration_id === INTEGRATION);
    expect(integ!.run_blocking).toBe(true);

    expect((await postRun()).status).toBe(412);
  });

  it("active integration with one healthy connection → not blocking", async () => {
    await seedAgentWith(buildAgentManifest([INTEGRATION], true));
    await seedIntegration(false);
    await seedConnection();

    const body = (await (await getReadiness()).json()) as ReadinessBody;
    expect(body.blocks_run).toBe(false);
    expect(body.errors).toHaveLength(0);
    const integ = body.integrations.find((i) => i.integration_id === INTEGRATION);
    expect(integ!.run_blocking).toBe(false);
    expect(integ!.resolution.resolved_connection_id).not.toBeNull();
  });
});
