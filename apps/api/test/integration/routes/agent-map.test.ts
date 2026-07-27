// SPDX-License-Identifier: Apache-2.0

/**
 * GET /api/agents/:scope/:name/map — read-only visual map of an agent.
 *
 * The map is a projection, so the invariants worth asserting are about
 * faithfulness, not about verdicts of its own:
 *
 *   - the card set is the FULL manifest inventory, empty cards included (they
 *     are where the renderer offers to add the missing thing),
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

  it("bare agent → the full card inventory, empty ones included, defaulting to the draft", async () => {
    await seedAgentWith(agentManifest());

    const res = await getMap();
    expect(res.status).toBe(200);
    const body = (await res.json()) as MapBody;

    expect(body.agent.packageId).toBe(AGENT);
    expect(body.agent.version_ref).toBe("draft");

    // Nothing is declared, yet every card is present: the set of cards is the
    // inventory of what a manifest can hold, and an empty one is where the UI
    // offers to add the missing piece.
    expect(nodeIds(body).sort()).toEqual([
      "agent",
      "mcp_servers",
      "model",
      "schedules",
      "skills",
      "system_tools",
      "toolbox",
    ]);
    for (const id of ["schedules", "toolbox", "skills", "mcp_servers"]) {
      expect(body.nodes.find((n) => n.id === id)!.data.items).toEqual([]);
    }
    expect(body.edges.map((e) => e.id).sort()).toEqual([
      "agent->mcp_servers",
      "agent->skills",
      "agent->system_tools",
      "agent->toolbox",
      // The model is an input: it feeds the agent.
      "model->agent",
      "schedules->agent",
    ]);
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
    const inputX = byId.get("schedules")!.position.x;
    const agentX = byId.get("agent")!.position.x;
    const toolboxX = byId.get("toolbox")!.position.x;
    expect(inputX).toBeLessThan(agentX);
    expect(agentX).toBeLessThan(toolboxX);
    // Inputs share one column.
    expect(byId.get("model")!.position.x).toBe(inputX);
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

  it("a schedule shows up on the schedules card", async () => {
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
    expect(items[0]!.enabled).toBe(true);
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

  it("no org model → the model card says nothing is resolved, WITHOUT faking a diagnostic", async () => {
    await seedAgentWith(agentManifest());

    const body = (await (await getMap()).json()) as MapBody;

    const model = body.nodes.find((n) => n.id === "model")!;
    expect(model.data.resolved).toBe(false);
    expect(model.data.resolved_model_id).toBeNull();
    // The readiness gate does not check the model, so the map must not pretend
    // otherwise — the missing model is a card state, not a diagnostic.
    expect(body.diagnostics.some((d) => d.node_id === "model")).toBe(false);
  });

  it("system tools card lists ONLY what the agent actually has", async () => {
    await seedAgentWith(agentManifest({ runtime_tools: ["note"] }));

    const body = (await (await getMap()).json()) as MapBody;

    const items = body.nodes.find((n) => n.id === "system_tools")!.data.items as Array<
      Record<string, unknown>
    >;
    const ids = items.map((i) => i.id);
    // `note` is granted; `pin` is NOT, so it is absent rather than listed as a
    // greyed-out possibility — the card describes this agent, not the platform.
    expect(ids).toEqual(["note", "run_history", "recall_memory"]);
    // Wired by the sidecar on every run, independently of `runtime_tools`.
    expect(items.find((i) => i.id === "recall_memory")!.always).toBe(true);
    expect(items.find((i) => i.id === "run_history")!.always).toBe(true);
  });

  it("no runtime tool granted → only the always-on injected rows", async () => {
    await seedAgentWith(agentManifest({}));

    const body = (await (await getMap()).json()) as MapBody;

    const items = body.nodes.find((n) => n.id === "system_tools")!.data.items as Array<
      Record<string, unknown>
    >;
    expect(items.map((i) => i.id)).toEqual(["run_history", "recall_memory"]);
  });

  it("unknown agent → 404", async () => {
    const res = await app.request(`/api/agents/@maporg/nope/map`, {
      method: "GET",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});
