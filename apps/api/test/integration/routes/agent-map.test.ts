// SPDX-License-Identifier: Apache-2.0

/**
 * GET /api/agents/:scope/:name/map — read-only visual map of an agent.
 *
 * The map is a projection, so the invariants worth asserting are about
 * faithfulness, not about verdicts of its own:
 *
 *   - a card with nothing to show is OMITTED (never an empty box),
 *   - every edge connects a card to `agent` (three-column topology),
 *   - `diagnostics[]` carries the SAME failures the readiness gate raises, each
 *     routed to the node and row it belongs to,
 *   - the connection state per integration matches the connection resolver.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackage, seedSchedule } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const AGENT = "@maporg/agent";
const INTEGRATION = "@maporg/svc";
const MCP_SERVER = "@maporg/svc-server";
const SKILL = "@maporg/skill";

interface MapNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}
interface MapBody {
  agent: { packageId: string; display_name: string; version_ref: string };
  nodes: MapNode[];
  edges: Array<{ id: string; source: string; target: string }>;
  diagnostics: Array<{
    field: string;
    code: string;
    node_id: string | null;
    item_id: string | null;
  }>;
}

function agentManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: AGENT,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: "Map Agent",
    ...over,
  };
}

describe("GET /api/agents/:scope/:name/map", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "maporg" });
  });

  async function seedAgentWith(manifest: Record<string, unknown>, prompt = "Do the thing.") {
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: manifest,
      draftContent: prompt,
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
  }

  async function seedIntegration() {
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: INTEGRATION,
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
      }),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, INTEGRATION);
  }

  function getMap(query = "") {
    return app.request(`/api/agents/${AGENT}/map${query}`, {
      method: "GET",
      headers: authHeaders(ctx),
    });
  }

  function nodeIds(body: MapBody): string[] {
    return body.nodes.map((n) => n.id);
  }

  it("bare agent → only the cards that have content, defaulting to the draft", async () => {
    await seedAgentWith(agentManifest());

    const res = await getMap();
    expect(res.status).toBe(200);
    const body = (await res.json()) as MapBody;

    expect(body.agent.packageId).toBe(AGENT);
    expect(body.agent.version_ref).toBe("draft");

    // No integration, skill, mcp server or schedule declared → those cards are
    // absent rather than rendered empty.
    expect(nodeIds(body).sort()).toEqual(["agent", "triggers"]);
    expect(body.edges).toEqual([{ id: "triggers->agent", source: "triggers", target: "agent" }]);
    expect(body.diagnostics).toHaveLength(0);
  });

  it("every edge terminates on the agent, and the three columns are distinct", async () => {
    await seedAgentWith(
      agentManifest({
        dependencies: { integrations: { [INTEGRATION]: "^1.0.0" }, skills: { [SKILL]: "^1.0.0" } },
        integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
      }),
    );
    await seedIntegration();

    const body = (await (await getMap()).json()) as MapBody;

    for (const edge of body.edges) {
      expect(edge.source === "agent" || edge.target === "agent").toBe(true);
    }
    const byId = new Map(body.nodes.map((n) => [n.id, n]));
    const triggersX = byId.get("triggers")!.position.x;
    const agentX = byId.get("agent")!.position.x;
    const toolboxX = byId.get("toolbox")!.position.x;
    expect(triggersX).toBeLessThan(agentX);
    expect(agentX).toBeLessThan(toolboxX);
  });

  it("declared integration with no connection → not connected, run-blocking, diagnostic routed to its row", async () => {
    await seedAgentWith(
      agentManifest({
        dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
        integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
      }),
    );
    await seedIntegration();

    const body = (await (await getMap()).json()) as MapBody;

    const toolbox = body.nodes.find((n) => n.id === "toolbox");
    expect(toolbox).toBeDefined();
    const items = toolbox!.data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(INTEGRATION);
    expect(items[0]!.declared_version).toBe("^1.0.0");
    expect(items[0]!.tools).toEqual(["search"]);
    expect(items[0]!.connected).toBe(false);
    expect(items[0]!.run_blocking).toBe(true);

    // Same failure the run gate raises, addressed to the exact card row.
    const diag = body.diagnostics.find((d) => d.code === "not_connected");
    expect(diag).toBeDefined();
    expect(diag!.node_id).toBe("toolbox");
    expect(diag!.item_id).toBe(INTEGRATION);
  });

  it("missing skill → skills card lists it unresolved and the diagnostic routes to its row", async () => {
    await seedAgentWith(agentManifest({ dependencies: { skills: { [SKILL]: "^1.0.0" } } }));

    const body = (await (await getMap()).json()) as MapBody;

    const skills = body.nodes.find((n) => n.id === "skills");
    expect(skills).toBeDefined();
    const items = skills!.data.items as Array<Record<string, unknown>>;
    expect(items[0]!.id).toBe(SKILL);
    expect(items[0]!.resolved).toBe(false);

    const diag = body.diagnostics.find((d) => d.code === "missing_skill");
    expect(diag).toBeDefined();
    expect(diag!.node_id).toBe("skills");
    expect(diag!.item_id).toBe(SKILL);
  });

  it("empty prompt → diagnostic routed to the agent card", async () => {
    await seedAgentWith(agentManifest(), "   ");

    const body = (await (await getMap()).json()) as MapBody;

    const diag = body.diagnostics.find((d) => d.code === "empty_prompt");
    expect(diag).toBeDefined();
    expect(diag!.node_id).toBe("agent");
    expect(diag!.item_id).toBeNull();
  });

  it("a schedule adds the schedules card and marks the schedule trigger configured", async () => {
    await seedAgentWith(agentManifest());
    await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      name: "Nightly",
      cronExpression: "0 21 * * *",
      timezone: "America/Montreal",
    });

    const body = (await (await getMap()).json()) as MapBody;

    const schedules = body.nodes.find((n) => n.id === "schedules");
    expect(schedules).toBeDefined();
    const items = schedules!.data.items as Array<Record<string, unknown>>;
    expect(items[0]!.cron_expression).toBe("0 21 * * *");
    expect(items[0]!.timezone).toBe("America/Montreal");

    const triggers = body.nodes.find((n) => n.id === "triggers")!;
    const trigger = (triggers.data.items as Array<Record<string, unknown>>).find(
      (t) => t.kind === "schedule",
    );
    expect(trigger!.configured).toBe(true);
  });

  it("declared mcp servers get their own card (the manifest group Fleet has no equivalent for)", async () => {
    await seedAgentWith(
      agentManifest({ dependencies: { mcp_servers: { [MCP_SERVER]: "^2.0.0" } } }),
    );

    const body = (await (await getMap()).json()) as MapBody;

    const mcp = body.nodes.find((n) => n.id === "mcp_servers");
    expect(mcp).toBeDefined();
    expect(mcp!.data.items).toEqual([{ id: MCP_SERVER, version: "^2.0.0" }]);
  });

  it("unknown agent → 404", async () => {
    const res = await app.request(`/api/agents/@maporg/nope/map`, {
      method: "GET",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});
