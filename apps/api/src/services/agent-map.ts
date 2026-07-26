// SPDX-License-Identifier: Apache-2.0

/**
 * Agent visual map — projects an agent's manifest and its installation state
 * into a positioned node/edge graph the dashboard renders with React Flow.
 *
 * The map is a READ-ONLY projection: it owns no data and computes no verdict of
 * its own. Every fact comes from the existing single source of truth for that
 * fact — the effective manifest (`resolveAgentRunVersion`), the app install
 * (`getPackageConfig`), the schedule table (`listPackageSchedules`), the
 * connection resolver (`resolveAgentConnectionReadiness`) and the readiness
 * gate (`collectAgentReadinessErrors`). Adding a check here would let the map
 * disagree with the run gate, which is the one thing it must never do.
 *
 * Layout is computed server-side (like LangSmith Fleet's, which hardcodes it):
 * three columns — what triggers the agent on the left, the agent in the middle,
 * what it can do on the right.
 *
 * EVERY node is always emitted, including the empty ones: the card set is the
 * inventory of what an AFPS agent manifest can hold, so an absent skill section
 * is itself information ("this agent has none, and here is where you'd add
 * one"). The renderer turns each empty card into an entry point to the existing
 * editor. Positions are still derived rather than literal, because card heights
 * vary with their contents.
 */

import type { Context } from "hono";
import type { AppEnv, LoadedPackage } from "../types/index.ts";
import type { ValidationFieldError } from "../lib/errors.ts";
import type { EnrichedSchedule } from "@appstrate/shared-types";
import { getPackageWithAccess } from "../services/package-catalog.ts";
import { resolveDeclaredSkills } from "../services/package-catalog.ts";
import {
  resolveAgentRunVersion,
  VERSION_SELECTOR_DRAFT,
} from "../services/agent-version-resolver.ts";
import { listPackageSchedules } from "../services/scheduler.ts";
import { getPackageConfig } from "../services/application-packages.ts";
import { resolveAgentConnectionReadiness } from "../services/integration-pins-service.ts";
import { collectAgentReadinessErrors } from "../services/agent-readiness.ts";
import { isToolsWildcard, parseManifestIntegrations } from "@appstrate/core/dependencies";
import { asJSONSchemaObject, mergeWithDefaults } from "@appstrate/core/form";
import { getAppScope } from "../lib/scope.ts";
import { getActor } from "../lib/actor.ts";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type AgentMapNodeType =
  "triggers" | "schedules" | "agent" | "toolbox" | "skills" | "mcp_servers";

export interface AgentMapNode {
  id: string;
  type: AgentMapNodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface AgentMapEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * A readiness failure, routed to the node (and item) it belongs to so the
 * renderer can badge the exact row instead of showing a page-level banner.
 * `node_id`/`item_id` are null when the field has no place on the map.
 */
export interface AgentMapDiagnostic {
  field: string;
  code: string;
  title: string | null;
  message: string;
  node_id: string | null;
  item_id: string | null;
}

export interface AgentMap {
  agent: {
    packageId: string;
    display_name: string;
    version: string | null;
    /** Version selector this projection was built from (`draft` or a semver/dist-tag). */
    version_ref: string;
    source: string;
  };
  nodes: AgentMapNode[];
  edges: AgentMapEdge[];
  diagnostics: AgentMapDiagnostic[];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Column abscissae. Left = inputs, centre = the agent, right = capabilities.
 * Chosen to leave room for the widest card at 100% zoom; the client calls
 * `fitView` so absolute values only set relative spacing.
 */
const COLUMN_X = { input: -560, agent: -140, capability: 240 } as const;

/** Vertical breathing room between two stacked cards in the same column. */
const COLUMN_GAP = 48;

/** Card chrome (title bar + padding) above the first row. */
const CARD_HEADER = 56;

/** One list row inside a card. */
const CARD_ROW = 44;

/**
 * Rows past this scroll inside the card, so a 60-tool toolbox does not stretch
 * the column to an unusable height (Fleet clips the same way).
 */
const MAX_VISIBLE_ROWS = 8;

function estimateHeight(itemCount: number): number {
  // A zero-item card still renders its empty state, which occupies one row.
  const rows = Math.min(Math.max(itemCount, 1), MAX_VISIBLE_ROWS);
  return CARD_HEADER + rows * CARD_ROW;
}

/**
 * Assign positions to a column's cards, stacked top to bottom and centred on
 * `y = 0` so columns of unequal height stay visually balanced.
 */
function stackColumn(
  x: number,
  cards: Array<{ node: Omit<AgentMapNode, "position">; itemCount: number }>,
): AgentMapNode[] {
  const heights = cards.map((c) => estimateHeight(c.itemCount));
  const total = heights.reduce((sum, h) => sum + h, 0) + COLUMN_GAP * Math.max(cards.length - 1, 0);
  let y = -total / 2;
  return cards.map((card, i) => {
    const position = { x, y };
    y += heights[i]! + COLUMN_GAP;
    return { ...card.node, position };
  });
}

// ---------------------------------------------------------------------------
// Diagnostic routing
// ---------------------------------------------------------------------------

/**
 * Map a readiness field path onto the map node (and row) it describes.
 *
 * The field prefixes are the readiness gate's own contract
 * (`agent-readiness.ts`): `prompt`, `config.<key>`,
 * `dependencies.skills.<id>`, `integrations.<id>`. Routing off them means a
 * new readiness check lands on the right card with no change here, and an
 * unrecognised prefix degrades to a map-level diagnostic instead of being
 * dropped.
 */
function routeDiagnostic(field: string): { nodeId: string | null; itemId: string | null } {
  if (field === "prompt" || field === "config" || field.startsWith("config.")) {
    return { nodeId: "agent", itemId: null };
  }
  const skill = field.match(/^dependencies\.skills\.(.+)$/);
  if (skill) return { nodeId: "skills", itemId: skill[1]! };
  const integration = field.match(/^integrations\.(.+)$/);
  if (integration) return { nodeId: "toolbox", itemId: integration[1]! };
  return { nodeId: null, itemId: null };
}

function toDiagnostic(e: ValidationFieldError): AgentMapDiagnostic {
  const { nodeId, itemId } = routeDiagnostic(e.field);
  return {
    field: e.field,
    code: e.code,
    title: e.title ?? null,
    message: e.message,
    node_id: nodeId,
    item_id: itemId,
  };
}

// ---------------------------------------------------------------------------
// Trigger inventory
// ---------------------------------------------------------------------------

/**
 * The ways a run can start. Unlike Fleet's "channels" card (which lists
 * connectable inbound providers), our entry points are platform-level and
 * always available, so this card documents them rather than offering setup.
 * `configured` marks the ones this agent actually has wired.
 */
function buildTriggers(scheduleCount: number, hasInputSchema: boolean) {
  return [
    { kind: "manual", configured: true },
    { kind: "schedule", configured: scheduleCount > 0 },
    { kind: "api", configured: true },
    // Input-schema-driven: an agent with no declared input can still be
    // launched from chat, but cannot be handed structured arguments.
    { kind: "chat", configured: true, accepts_input: hasInputSchema },
  ];
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function scheduleCard(schedules: EnrichedSchedule[]) {
  return schedules.map((s) => ({
    id: s.id,
    name: s.name,
    cron_expression: s.cron_expression,
    timezone: s.timezone,
    enabled: s.enabled,
    next_run_at: s.next_run_at,
    last_run_at: s.last_run_at,
    actor_name: s.actor_name,
    // A schedule pinned to a version runs a different definition than the one
    // this map projects — worth surfacing on the card.
    version_override: s.version_override,
  }));
}

/**
 * Build the map for the agent addressed by the current request.
 *
 * Returns `null` when the agent is not installed in the calling application,
 * so the route maps it to a 404 (same semantics as the agent detail endpoint).
 */
export async function buildAgentMap(
  c: Context<AppEnv>,
  opts: { itemId: string; version?: string },
): Promise<AgentMap | null> {
  const scope = getAppScope(c);
  const { orgId, applicationId } = scope;
  const role = c.get("orgRole");
  const isAdmin = role === "admin" || role === "owner";

  const loaded = await getPackageWithAccess(opts.itemId, orgId, applicationId);
  if (!loaded) return null;

  // Default to the working copy, matching `connection-readiness` — a map of a
  // never-published agent must render, where `resolveAgentRunVersion` would
  // 404 on an omitted selector.
  const versionRef = opts.version?.trim() || VERSION_SELECTOR_DRAFT;
  const { agent } = await resolveAgentRunVersion(loaded, versionRef);
  const manifest = agent.manifest as unknown as Record<string, unknown>;

  const declaredIntegrations = parseManifestIntegrations(manifest);
  const declaredMcpServers = Object.entries(
    (manifest as { dependencies?: { mcp_servers?: Record<string, string> } }).dependencies
      ?.mcp_servers ?? {},
  ).map(([id, version]) => ({ id, version }));

  const [schedules, declaredSkills, packageConfig, connectionReadiness] = await Promise.all([
    listPackageSchedules(scope, agent.id),
    resolveDeclaredSkills(agent.manifest, orgId),
    getPackageConfig(applicationId, agent.id),
    // Skipped entirely when nothing is declared — the resolver would fan out
    // per integration for an empty answer.
    declaredIntegrations.length > 0
      ? resolveAgentConnectionReadiness({
          scope,
          agentPackageId: agent.id,
          actor: getActor(c),
          isAdmin,
          version: versionRef,
        })
      : Promise.resolve(null),
  ]);

  const configSchema = agent.manifest.config?.schema
    ? asJSONSchemaObject(agent.manifest.config.schema)
    : null;
  const effectiveConfig = configSchema
    ? mergeWithDefaults(configSchema, packageConfig.config)
    : packageConfig.config;

  // Readiness minus connections: the connection verdict already arrives via
  // `connectionReadiness` above, and passing an actor here would run the same
  // resolver a second time on the request path.
  const readinessErrors = await collectAgentReadinessErrors({
    agent: agent as LoadedPackage,
    orgId,
    applicationId,
    actor: null,
    config: effectiveConfig,
  });

  const connectionByIntegration = new Map(
    (connectionReadiness?.integrations ?? []).map((i) => [i.integration_id, i]),
  );

  const diagnostics = [...readinessErrors, ...(connectionReadiness?.errors ?? [])].map(
    toDiagnostic,
  );

  // --- Left column: what starts a run -------------------------------------

  const triggers = buildTriggers(schedules.length, !!agent.manifest.input?.schema);
  const leftCards: Array<{ node: Omit<AgentMapNode, "position">; itemCount: number }> = [
    {
      node: { id: "triggers", type: "triggers", data: { items: triggers } },
      itemCount: triggers.length,
    },
    {
      node: {
        id: "schedules",
        type: "schedules",
        data: { items: scheduleCard(schedules) },
      },
      itemCount: schedules.length,
    },
  ];

  // --- Centre column: the agent itself ------------------------------------

  const centreCards = [
    {
      node: {
        id: "agent",
        type: "agent" as const,
        data: {
          display_name: agent.manifest.display_name,
          description: agent.manifest.description ?? null,
          prompt: agent.prompt ?? null,
          timeout: agent.manifest.timeout ?? null,
          runtime_tools: agent.manifest.runtime_tools ?? [],
          modelId: packageConfig.modelId,
          proxyId: packageConfig.proxyId,
          has_input_schema: !!agent.manifest.input?.schema,
          has_output_schema: !!agent.manifest.output?.schema,
          has_config_schema: !!(
            configSchema?.properties && Object.keys(configSchema.properties).length > 0
          ),
        },
      },
      // The agent card is prose, not a list; one row keeps it centred against
      // the tallest neighbouring column.
      itemCount: 1,
    },
  ];

  // --- Right column: what it can do ---------------------------------------

  const toolboxItems = declaredIntegrations.map((entry) => {
    const readiness = connectionByIntegration.get(entry.id);
    const resolution = readiness?.resolution;
    return {
      id: entry.id,
      declared_version: entry.version,
      // AFPS §4.4 wildcard — keep the `"*"` literal instead of spreading the
      // string into single characters.
      ...(entry.tools !== undefined
        ? { tools: isToolsWildcard(entry.tools) ? entry.tools : [...entry.tools] }
        : {}),
      ...(entry.scopes !== undefined ? { scopes: [...entry.scopes] } : {}),
      status: resolution?.status ?? null,
      connected: resolution ? resolution.resolved_connection_id !== null : null,
      locked: resolution
        ? resolution.status === "admin_locked" || resolution.org_default_enforced
        : null,
      missing_scopes: resolution?.resolved_missing_scopes ?? [],
      run_blocking: readiness?.run_blocking ?? false,
    };
  });

  const rightCards: Array<{ node: Omit<AgentMapNode, "position">; itemCount: number }> = [
    {
      node: { id: "toolbox", type: "toolbox", data: { items: toolboxItems } },
      itemCount: toolboxItems.length,
    },
    {
      node: {
        id: "skills",
        type: "skills",
        data: {
          items: declaredSkills.map((s) => ({
            id: s.id,
            declared_version: s.version ?? null,
            resolved: s.resolved,
            name: s.name ?? null,
            description: s.description ?? null,
          })),
        },
      },
      itemCount: declaredSkills.length,
    },
    {
      node: {
        id: "mcp_servers",
        type: "mcp_servers",
        data: { items: declaredMcpServers },
      },
      itemCount: declaredMcpServers.length,
    },
  ];

  const nodes = [
    ...stackColumn(COLUMN_X.input, leftCards),
    ...stackColumn(COLUMN_X.agent, centreCards),
    ...stackColumn(COLUMN_X.capability, rightCards),
  ];

  // Inputs flow into the agent, capabilities flow out of it. Direction carries
  // the meaning, so it is derived from the column rather than stored.
  const edges: AgentMapEdge[] = [
    ...leftCards.map((c) => ({
      id: `${c.node.id}->agent`,
      source: c.node.id,
      target: "agent",
    })),
    ...rightCards.map((c) => ({
      id: `agent->${c.node.id}`,
      source: "agent",
      target: c.node.id,
    })),
  ];

  return {
    agent: {
      packageId: agent.id,
      display_name: agent.manifest.display_name,
      version: agent.manifest.version ?? null,
      version_ref: versionRef,
      source: agent.source,
    },
    nodes,
    edges,
    diagnostics,
  };
}
