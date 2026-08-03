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
 * three columns — what triggers the agent on the left, what it can do on the
 * right, and in the middle the agent's own axis, its input above it and its
 * output below. Two flows crossing on the agent: what it is wired TO runs
 * horizontally, the data running THROUGH it runs vertically.
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
import { listOrgModels } from "../services/org-models.ts";
import { RUNTIME_TOOL_CATALOG } from "@appstrate/core/runtime-tools-catalog";
import { RUNTIME_INJECTED_TOOLS } from "@appstrate/runner-pi/runtime-tools";
import { isToolsWildcard, parseManifestIntegrations } from "@appstrate/core/dependencies";
import { asJSONSchemaObject, mergeWithDefaults } from "@appstrate/core/form";
import { getAppScope } from "../lib/scope.ts";
import { getActor } from "../lib/actor.ts";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * NEVER name a type `input`, `output`, `default` or `group`: React Flow reserves
 * those four for its built-in nodes and its stylesheet dresses
 * `.react-flow__node-input` with its own border, padding and background, which
 * drew a second box behind our card.
 */
export type AgentMapNodeType =
  | "schedules"
  | "config"
  | "agent_input"
  | "agent"
  | "model"
  | "agent_output"
  | "toolbox"
  | "skills"
  | "mcp_servers"
  | "system_tools";

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
  /**
   * Which side of each card the edge leaves from and arrives at.
   *
   * Emitted because the agent card carries two of each: capabilities come and go
   * horizontally while the contract flows vertically through it, and React Flow
   * cannot guess which handle an edge meant when a node has several. Layout is
   * already this service's job, and an anchor is part of a layout.
   */
  source_handle: HandleSide;
  target_handle: HandleSide;
}

export type HandleSide = "top" | "right" | "bottom" | "left";

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
 * Column abscissae. Three columns, and the middle one carries the agent's own
 * data flow: the input above it, the agent, its output below.
 *
 * Input and output used to sit in the outer columns, which put them on the same
 * footing as a schedule or a skill. They are not peers of those: they are the
 * agent's own two ends, so they belong on its axis, and the horizontal axis is
 * left to what the agent is wired TO. Chosen to leave room for the widest card
 * at 100% zoom; the client calls `fitView` so absolute values only set relative
 * spacing.
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

/**
 * The agent card is prose, not rows: name, description, timeout, then the prompt
 * clamped to six lines. Measured in the browser at 248px, and near-constant
 * because of that clamp. It needs its own number now that the card is STACKED
 * between its input and its output — an item count of 1 predicted 100px, and the
 * card sat 100px on top of the output card.
 */
const AGENT_CARD_HEIGHT = 248;

function estimateHeight(itemCount: number): number {
  // A zero-item card still renders its empty state, which occupies one row.
  const rows = Math.min(Math.max(itemCount, 1), MAX_VISIBLE_ROWS);
  return CARD_HEADER + rows * CARD_ROW;
}

interface ColumnCard {
  node: Omit<AgentMapNode, "position">;
  /** Rows the card lists; drives the height estimate for list cards. */
  itemCount: number;
  /** Overrides the estimate for a card that is not a list (the agent's prose). */
  height?: number;
}

/**
 * Assign positions to a column's cards, stacked top to bottom and centred on
 * `y = 0` so columns of unequal height stay visually balanced.
 */
function stackColumn(x: number, cards: ColumnCard[]): AgentMapNode[] {
  const heights = cards.map((c) => c.height ?? estimateHeight(c.itemCount));
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
  if (field === "prompt") return { nodeId: "agent", itemId: null };
  // Config has its own card now, so a bad value lands on the exact setting
  // instead of being lumped onto the agent card with the empty-prompt error.
  if (field === "config") return { nodeId: "config", itemId: null };
  const configKey = field.match(/^config\.(.+)$/);
  if (configKey) return { nodeId: "config", itemId: configKey[1]! };
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
// Projection
//
// There is deliberately NO "triggers" card, and no equivalent of Fleet's
// "channels". Fleet's channels are INBOUND (a Slack bot, a mailbox that fires the
// agent); our integrations are outbound (the agent calls the API) and our
// webhooks are outbound too (they notify, they do not fire). The remaining entry
// points — manual, API key, chat — are platform-level and identical for every
// agent, so listing them said nothing about the agent being looked at while
// taking the most readable slot on the canvas. The only variable one, a
// schedule, has its own card. When an event-driven trigger exists (inbound mail,
// inbound webhook), a trigger card can come back with real content.
// ---------------------------------------------------------------------------

/**
 * Top-level fields of an AFPS schema wrapper (`input` / `output`), for the two
 * contract cards.
 *
 * These are the agent's INTERFACE — what a caller must hand it, what it hands
 * back — which is a different thing from the `output` runtime tool listed under
 * system tools. That tool is the mechanism the agent uses to emit a result; this
 * is the shape that result must have. An agent can declare neither, either or
 * both, so both cards render empty rather than disappearing.
 *
 * Only the first level is projected: a card is a summary, and nested objects
 * belong to the schema editor, which the card's action opens.
 */
function contractFields(
  wrapper: { schema?: unknown; property_order?: unknown } | null | undefined,
) {
  const schema = wrapper?.schema ? asJSONSchemaObject(wrapper.schema) : null;
  if (!schema?.properties) return [];
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map((r) => String(r)) : [],
  );
  // AFPS §3.4 `property_order` is the author's intended order, and it is the ONLY
  // thing that can carry it: manifests are stored as `jsonb`, which normalises
  // key order (shortest first, then bytewise), so `Object.entries` hands back
  // "seuil" before "destinataire" no matter how the manifest was written.
  // Unlisted fields keep whatever order the storage gives, after the listed ones.
  const order = Array.isArray(wrapper?.property_order)
    ? wrapper.property_order.map((k) => String(k))
    : [];
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i === -1 ? order.length : i;
  };
  const entries = Object.entries(schema.properties).sort(([a], [b]) => rank(a) - rank(b));
  return entries.map(([name, definition]) => {
    const field = (definition ?? {}) as { type?: unknown; title?: unknown };
    return {
      name,
      title: typeof field.title === "string" ? field.title : null,
      type: Array.isArray(field.type)
        ? field.type.map((t) => String(t)).join(" | ")
        : typeof field.type === "string"
          ? field.type
          : null,
      required: required.has(name),
    };
  });
}

/**
 * One-line rendering of a config value for the card.
 *
 * `null` means "not set" and stays null so the renderer can say so in the
 * reader's language rather than printing the word. Objects and arrays are
 * compacted and clipped: a card row is a summary, and the full value belongs to
 * the settings form the row opens.
 */
function serialiseConfigValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const json = JSON.stringify(value);
  return json.length > 60 ? `${json.slice(0, 57)}…` : json;
}

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

  const [schedules, declaredSkills, packageConfig, connectionReadiness, orgModelList] =
    await Promise.all([
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
      // The map only needs ids and the default flag; the resolver's own
      // credential probe is what decides which rows are renderable.
      listOrgModels(orgId),
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

  // The model an agent thinks with: its own override when set, otherwise the
  // org's default. `resolved: false` is a fact (no model would be available at
  // run time), NOT a readiness diagnostic — the gate does not check the model,
  // so inventing one here would make the map claim more than the run does.
  const orgDefaultModel = orgModelList.find((m) => m.is_default && m.enabled);
  const resolvedModelId = packageConfig.modelId ?? orgDefaultModel?.id ?? null;
  // Model ids are opaque row ids; the card needs the human label the model
  // pickers show. Unknown id (deleted model still pinned on the install) keeps
  // the id as its own label rather than rendering blank.
  const resolvedModelLabel =
    orgModelList.find((m) => m.id === resolvedModelId)?.label ?? resolvedModelId;

  const inputFields = contractFields(agent.manifest.input);
  const outputFields = contractFields(agent.manifest.output);

  const leftCards: ColumnCard[] = [
    {
      node: {
        id: "schedules",
        type: "schedules",
        data: { items: scheduleCard(schedules) },
      },
      itemCount: schedules.length,
    },
    // The model feeds the agent, like a trigger fires it — an input, not a
    // capability the agent reaches out to.
    {
      node: {
        id: "model",
        type: "model",
        data: {
          agent_model_id: packageConfig.modelId,
          org_default_model_id: orgDefaultModel?.id ?? null,
          resolved_model_id: resolvedModelId,
          resolved_model_label: resolvedModelLabel,
          resolved: resolvedModelId !== null,
          inherited: packageConfig.modelId === null && resolvedModelId !== null,
          proxyId: packageConfig.proxyId,
        },
      },
      itemCount: 1,
    },
    // Settings, not a flow: `config` is fixed once per installation, where
    // `input` is handed over at every run. That is why it sits beside the model
    // — also a per-application setting — rather than on the agent's axis.
    {
      node: {
        id: "config",
        type: "config",
        data: {
          items: contractFields(agent.manifest.config).map((field) => ({
            ...field,
            // The declared shape is only half of it: what makes a config card
            // worth reading is the value this application actually runs with,
            // defaults already merged in.
            value: serialiseConfigValue(effectiveConfig[field.name]),
          })),
        },
      },
      itemCount: Object.keys(configSchema?.properties ?? {}).length,
    },
  ];

  // --- Centre column: the agent's own axis, input → agent → output ---------

  const centreCards: ColumnCard[] = [
    {
      node: { id: "input", type: "agent_input", data: { items: inputFields } },
      itemCount: inputFields.length,
    },
    {
      node: {
        id: "agent",
        type: "agent",
        // What the prose card actually renders, and nothing else: the model,
        // proxy, config and the two schemas each ended up with a card of their
        // own, leaving this payload shipping four fields no renderer read.
        data: {
          display_name: agent.manifest.display_name,
          description: agent.manifest.description ?? null,
          prompt: agent.prompt ?? null,
          timeout: agent.manifest.timeout ?? null,
        },
      },
      itemCount: 1,
      height: AGENT_CARD_HEIGHT,
    },
    {
      node: { id: "output", type: "agent_output", data: { items: outputFields } },
      itemCount: outputFields.length,
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

  // Platform runtime tools the manifest GRANTS (`output`, `log`, `note`, `pin`,
  // `publish_document`), plus the runtime-INJECTED ones (`run_history`,
  // `recall_memory`), which the sidecar wires on every run whatever the manifest
  // says. Ungranted tools are deliberately absent: an empty card already says "you
  // could add this here", so listing the possibilities inside it would describe the
  // platform instead of this agent.
  //
  // Both halves come from their own registry rather than a local list, so a tool
  // added to either shows up here untouched. And deliberately no counts of pinned
  // blocks or archived notes — that is per-actor execution state, while the map
  // projects the definition.
  const declaredRuntimeTools = agent.manifest.runtime_tools ?? [];
  const systemToolItems = [
    ...RUNTIME_TOOL_CATALOG.filter((tool) => declaredRuntimeTools.includes(tool.id)).map(
      (tool) => ({ id: tool.id, always: false }),
    ),
    ...RUNTIME_INJECTED_TOOLS.map((tool) => ({ id: tool.id, always: true })),
  ];

  const rightCards: ColumnCard[] = [
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
    {
      node: { id: "system_tools", type: "system_tools", data: { items: systemToolItems } },
      itemCount: systemToolItems.length,
    },
  ];

  const nodes = [
    ...stackColumn(COLUMN_X.input, leftCards),
    ...stackColumn(COLUMN_X.agent, centreCards),
    ...stackColumn(COLUMN_X.capability, rightCards),
  ];

  // Two flows crossing on the agent, and the handles say which is which:
  // horizontally, what fires it and what it can reach; vertically, the data
  // going through it. Direction carries the meaning, so it is derived from the
  // column rather than stored.
  const edges: AgentMapEdge[] = [
    ...leftCards.map((c) => ({
      id: `${c.node.id}->agent`,
      source: c.node.id,
      target: "agent",
      source_handle: "right" as const,
      target_handle: "left" as const,
    })),
    ...rightCards.map((c) => ({
      id: `agent->${c.node.id}`,
      source: "agent",
      target: c.node.id,
      source_handle: "right" as const,
      target_handle: "left" as const,
    })),
    {
      id: "input->agent",
      source: "input",
      target: "agent",
      source_handle: "bottom",
      target_handle: "top",
    },
    {
      id: "agent->output",
      source: "agent",
      target: "output",
      source_handle: "bottom",
      target_handle: "top",
    },
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
