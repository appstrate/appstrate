// SPDX-License-Identifier: Apache-2.0

/**
 * Agent Map module — EXPERIMENTAL, opt-in.
 *
 * Serves `GET /api/agents/:scope/:name/map`: the agent's manifest projected as
 * a positioned graph, crossed with the installation state and annotated with
 * the same readiness diagnostics the run gate raises.
 *
 * The projection owns no data and computes no verdict of its own. Every fact
 * comes from the existing single source of truth — the effective manifest, the
 * app install, the schedule table, the connection resolver, the readiness gate.
 * That constraint is the point: the map can never disagree with what a run
 * would actually do. It is why the service imports those core services directly
 * (a built-in dir module may) instead of recomposing them from REST: recomposed
 * facts are a second implementation of the verdict, and a second implementation
 * is exactly what can drift.
 *
 * NOT in the `MODULES` default. Enable with `MODULES=...,agent-map`; the SPA
 * tab follows the `agentMap` feature flag below and disappears with it.
 *
 * Owns no tables. Contributes one route, one OpenAPI path, three component
 * schemas (exempt from shared-type pairing — the SPA reads the generated spec
 * types) and one feature flag.
 */

import type { AppstrateModule } from "@appstrate/core/module";
import { createAgentMapRouter } from "./routes.ts";
import { agentMapPaths } from "./openapi/paths.ts";
import { agentMapSchemas } from "./openapi/schemas.ts";

const agentMapModule: AppstrateModule = {
  manifest: { id: "agent-map", name: "Agent Map", version: "0.1.0" },

  async init() {
    // Stateless projection — no workers, no tables, nothing to initialize.
  },

  createRouter() {
    return createAgentMapRouter();
  },

  features: { agentMap: true },

  openApiPaths() {
    return agentMapPaths;
  },

  openApiComponentSchemas() {
    return agentMapSchemas;
  },

  openApiExemptSchemas() {
    return {
      AgentMap:
        "agent visual-map envelope (read-only manifest×install projection); SPA uses the generated spec type",
      AgentMapNode: "AgentMap.nodes[] item; node-type-dependent `data`, no shared-type twin",
      AgentMapDiagnostic: "AgentMap.diagnostics[] item; SPA uses the generated spec type",
    };
  },
};

export default agentMapModule;
