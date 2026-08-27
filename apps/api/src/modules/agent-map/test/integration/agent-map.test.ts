// SPDX-License-Identifier: Apache-2.0

/**
 * GET /api/agents/:scope/:name/map — read-only visual map of an agent.
 *
 * The map is a projection, so the invariants worth asserting are about
 * faithfulness, not about verdicts of its own:
 *
 *   - the card set is the FULL manifest inventory, empty cards included (they
 *     are where the renderer offers to add the missing thing),
 *   - every edge connects two emitted cards and follows the map's semantic zones,
 *   - `diagnostics[]` carries the SAME failures the readiness gate raises, each
 *     routed to the node and row it belongs to,
 *   - the connection state per integration matches the connection resolver.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import agentMapModule from "../../index.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../test/helpers/auth.ts";
import { seedAgent, seedPackage, seedSchedule } from "../../../../../test/helpers/seed.ts";
import { installPackage } from "../../../../services/application-packages.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../../../../test/helpers/integration-manifests.ts";

// The map route is module-owned: core's `getTestApp()` loads no modules, so the
// endpoint 404s without this. Same wiring every module test uses.
const app = getTestApp({ modules: [agentMapModule] });

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
  edges: Array<{
    id: string;
    source: string;
    target: string;
    source_handle: string;
    target_handle: string;
  }>;
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
      "connections",
      "input",
      "input_values",
      "mcp_servers",
      "memory",
      "model",
      "output",
      "proxy",
      "schedules",
      "skills",
      "system_tools",
      "toolbox",
    ]);
    for (const id of [
      "schedules",
      "connections",
      "toolbox",
      "skills",
      "mcp_servers",
      "memory",
      "input",
      "output",
      "input_values",
    ]) {
      expect(body.nodes.find((n) => n.id === id)!.data.items).toEqual([]);
    }
    expect(body.edges.map((e) => e.id).sort()).toEqual([
      // The result flows out of the agent, like a capability it reaches for.
      "agent->output",
      "dependency-mcp_servers",
      "dependency-skills",
      "dependency-system_tools",
      "dependency-toolbox",
      // The model is an input: it feeds the agent.
      "input->agent",
      "resolution-connections",
      "resolution-input-values",
      "resolution-memory-read",
      "resolution-memory-write",
      "resolution-model",
      "resolution-proxy",
      "resolution-schedules",
    ]);
    expect(body.diagnostics).toHaveLength(0);
  });

  it("every edge connects two emitted cards, and the columns are ordered left to right", async () => {
    await seedAgentWith(
      agentManifest({
        dependencies: { integrations: { [INTEGRATION]: "^1.0.0" }, skills: { [SKILL]: "^1.0.0" } },
        integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
      }),
    );
    await seedIntegration();

    const body = (await (await getMap()).json()) as MapBody;

    const byId = new Map(body.nodes.map((n) => [n.id, n]));
    for (const edge of body.edges) {
      expect(byId.has(edge.source)).toBe(true);
      expect(byId.has(edge.target)).toBe(true);
    }
    const triggerX = byId.get("schedules")!.position.x;
    const agent = byId.get("agent")!;
    const toolboxX = byId.get("toolbox")!.position.x;
    // Horizontally: what fires the agent, the agent, what it can reach.
    expect(triggerX).toBeLessThan(agent.position.x);
    expect(agent.position.x).toBeLessThan(toolboxX);
    expect(byId.get("model")!.position.x).toBe(triggerX);

    // Vertically, on the agent's own axis: its input above, its output below.
    // They are the agent's two ends, not peers of a schedule or a skill.
    const input = byId.get("input")!;
    const output = byId.get("output")!;
    expect(input.position.x).toBe(agent.position.x);
    expect(output.position.x).toBe(agent.position.x);
    expect(input.position.y).toBeLessThan(agent.position.y);
    expect(agent.position.y).toBeLessThan(output.position.y);

    // And the handles say which flow an edge belongs to — without them React
    // Flow cannot tell which of the agent's four sides an edge meant.
    const byEdge = new Map(body.edges.map((e) => [e.id, e]));
    expect(byEdge.get("input->agent")).toMatchObject({
      source_handle: "bottom",
      target_handle: "top",
    });
    expect(byEdge.get("resolution-schedules")).toMatchObject({
      source_handle: "right",
      target_handle: "left",
    });
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

  it("declared input/output schemas → their own cards, one row per top-level field", async () => {
    await seedAgentWith(
      agentManifest({
        input: {
          schema: {
            type: "object",
            properties: {
              week: { type: "string", title: "Semaine" },
              verbose: { type: "boolean" },
            },
            required: ["week"],
          },
        },
        output: {
          schema: { type: "object", properties: { summary: { type: "string" } } },
        },
        // `output` the runtime tool is a different thing from `output.schema` the
        // contract, and declaring a schema is what makes the tool mandatory.
        runtime_tools: ["output"],
      }),
    );

    const body = (await (await getMap()).json()) as MapBody;

    expect(body.nodes.find((n) => n.id === "input")!.data.items).toEqual([
      { name: "week", title: "Semaine", type: "string", required: true },
      { name: "verbose", title: null, type: "boolean", required: false },
    ]);
    expect(body.nodes.find((n) => n.id === "output")!.data.items).toEqual([
      { name: "summary", title: null, type: "string", required: false },
    ]);
    // The contract cards do NOT absorb the runtime tool: it stays a granted
    // capability on its own card.
    const tools = body.nodes.find((n) => n.id === "system_tools")!.data.items as Array<
      Record<string, unknown>
    >;
    expect(tools.map((i) => i.id)).toContain("output");
  });

  it("config card carries the effective value, and a bad setting routes to its row", async () => {
    await seedAgentWith(
      agentManifest({
        config: {
          schema: {
            type: "object",
            required: ["destinataire"],
            properties: {
              destinataire: { type: "string", title: "Destinataire" },
              seuil: { type: "number", default: 5 },
            },
          },
          // Without this the card would list "seuil" first: manifests live in a
          // `jsonb` column, which reorders keys by length. AFPS §3.4 carries the
          // author's order precisely because storage cannot.
          property_order: ["destinataire", "seuil"],
        },
      }),
    );

    const body = (await (await getMap()).json()) as MapBody;

    const items = body.nodes.find((n) => n.id === "input_values")!.data.items as Array<
      Record<string, unknown>
    >;
    expect(items).toEqual([
      // Never set on this installation: null rather than a rendered word, so the
      // client says "not set" in the reader's own language.
      { name: "destinataire", title: "Destinataire", type: "string", required: true, value: null },
      // Not set either, but the schema default applies — so the map shows what a
      // run would actually use, not what the manifest literally stores.
      { name: "seuil", title: null, type: "number", required: false, value: "5" },
    ]);

    // A required setting left empty blocks the run, and that diagnostic belongs
    // on the setting itself rather than lumped onto the agent card.
    const diag = body.diagnostics.find((d) => d.field === "config.destinataire");
    expect(diag).toBeDefined();
    expect(diag!.node_id).toBe("input_values");
    expect(diag!.item_id).toBe("destinataire");
  });

  it("unknown agent → 404", async () => {
    const res = await app.request(`/api/agents/@maporg/nope/map`, {
      method: "GET",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});
