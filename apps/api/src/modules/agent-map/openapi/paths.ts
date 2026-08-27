// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI path definitions owned by the agent-map module.
 *
 * Tagged `Agents` on purpose: the operation hangs off an agent's own resource
 * path and belongs in that group of the docs, even though the module — not
 * core — contributes it. Absent from the spec when the module is disabled.
 */
export const agentMapPaths = {
  "/api/agents/{scope}/{name}/map": {
    get: {
      operationId: "getAgentMap",
      tags: ["Agents"],
      summary: "Visual map of an agent",
      description:
        "Projects the agent's manifest into positioned nodes and edges (triggers and schedules on the left, the agent in the middle, toolbox / skills / mcp servers on the right) crossed with the installation state: resolved versions against declared ranges, per-integration connection status, admin pins, active schedules. `diagnostics[]` carries the readiness failures routed to the node and row they belong to, sourced from the same readiness gate and connection resolver as the run-kickoff 412 — so the map cannot disagree with what a run would do. Read-only: it owns no data and computes no verdict of its own. Every card is emitted even when empty: the card set is the inventory of what an AFPS manifest can hold, and an empty card is where the missing piece gets added.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "version",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Which agent definition to map: `draft` (the live editor working copy), `published` (the latest published version), or a version spec (exact version, dist-tag, or semver range). **Omitting the parameter resolves the `draft`**, so a never-published agent still renders. Ignored for system agents.",
        },
      ],
      responses: {
        "200": {
          description: "Agent visual map",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/AgentMap" } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
};
