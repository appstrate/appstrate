// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI component schemas owned by the agent-map module.
 *
 * None of the three has a shared-type twin — the SPA consumes the generated
 * spec types directly — so the module declares them exempt from the step-7b
 * shared-type pairing in its `openApiExemptSchemas()`, rather than adding
 * entries to the core response-type registry.
 */
export const agentMapSchemas = {
  AgentMapNode: {
    type: "object",
    description:
      "One card of the visual map. `position` is computed server-side (three columns: what fires the agent on the left, the agent's own axis `input → agent → output` in the centre, its capabilities on the right) so every client lays the map out identically. `data` is node-type dependent: list cards carry `items[]`, the `agent` card carries the definition fields.",
    required: ["id", "type", "position", "data"],
    properties: {
      id: {
        type: "string",
        description: "Stable node id, also the edge endpoint.",
      },
      type: {
        type: "string",
        description:
          "Never `input`/`output`/`default`/`group`: React Flow reserves those names for its built-in nodes and styles them, which draws a second box behind the card. Hence `agent_input` / `agent_output`.",
        enum: [
          "schedules",
          "connections",
          "input_values",
          "agent_input",
          "agent",
          "model",
          "proxy",
          "agent_output",
          "toolbox",
          "skills",
          "mcp_servers",
          "system_tools",
          "memory",
        ],
      },
      position: {
        type: "object",
        required: ["x", "y"],
        properties: { x: { type: "number" }, y: { type: "number" } },
      },
      data: { type: "object", additionalProperties: true },
    },
  },
  AgentMapDiagnostic: {
    type: "object",
    description:
      "A readiness failure routed to the node (and row) it describes, so the renderer badges the exact item. Sourced from the same readiness gate and connection resolver the run-kickoff uses — the map can never disagree with the run. `node_id`/`item_id` are null for a field with no place on the map.",
    required: ["field", "code", "title", "message", "node_id", "item_id"],
    properties: {
      field: {
        type: "string",
        description:
          "Readiness field path: `prompt`, `config.<key>`, `dependencies.skills.<id>` or `integrations.<id>`.",
      },
      code: { type: "string" },
      title: { type: ["string", "null"] },
      message: { type: "string" },
      node_id: { type: ["string", "null"] },
      item_id: { type: ["string", "null"] },
    },
  },
  AgentMap: {
    type: "object",
    description:
      "Read-only visual map of an agent: its manifest projected as positioned nodes and edges, crossed with the installation state (resolved versions, connection status, admin pins, active schedules) and annotated with readiness diagnostics. The node set is FIXED — every card is emitted even when empty, because the card inventory is what an agent manifest can hold and an empty one is where the renderer offers to add the missing piece.",
    required: ["agent", "nodes", "edges", "diagnostics"],
    properties: {
      agent: {
        type: "object",
        required: ["packageId", "display_name", "version", "version_ref", "source"],
        properties: {
          packageId: { type: "string" },
          display_name: { type: "string" },
          version: { type: ["string", "null"] },
          version_ref: {
            type: "string",
            description: "Version selector this projection was built from (`draft` by default).",
          },
          source: { type: "string" },
        },
      },
      nodes: {
        type: "array",
        items: { $ref: "#/components/schemas/AgentMapNode" },
      },
      edges: {
        type: "array",
        description:
          "Directed: trigger cards point at the agent, capability cards are pointed at by it, and the contract flows down through it. The handles are part of the layout — the agent card carries one on each side, so an edge has to name the one it means.",
        items: {
          type: "object",
          required: ["id", "source", "target", "source_handle", "target_handle"],
          properties: {
            id: { type: "string" },
            source: { type: "string" },
            target: { type: "string" },
            source_handle: {
              type: "string",
              enum: ["top", "right", "bottom", "left"],
            },
            target_handle: {
              type: "string",
              enum: ["top", "right", "bottom", "left"],
            },
          },
        },
      },
      diagnostics: {
        type: "array",
        items: { $ref: "#/components/schemas/AgentMapDiagnostic" },
      },
    },
  },
};
