// SPDX-License-Identifier: Apache-2.0

/**
 * Agent visual map — the manifest and its installation state, drawn.
 *
 * Everything shown here is server-computed, positions included
 * (`GET /api/agents/{scope}/{name}/map`): the map must never disagree with what
 * a run would actually do, so the client neither derives verdicts nor lays out
 * the graph. The only client-side work is attaching each diagnostic to the node
 * that owns it, which the server already addressed by `node_id`.
 *
 * What IS shown is read-only; what it shows can be edited. Card headers open the
 * agent editor's own widgets in a dialog (see `map-edit-dialog.tsx`), which edit
 * the definition itself — the prompt as text, declared dependencies. The drawing
 * is never a source the definition gets generated from.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useAgentMap } from "../../hooks/use-agent-map";
import { ErrorState, LoadingState } from "../page-states";
import { MapEditDialog, type MapEditKind } from "./map-edit-dialog";
import {
  AgentNode,
  McpServersNode,
  MemoryNode,
  ModelNode,
  SchedulesNode,
  SkillsNode,
  ToolboxNode,
  TriggersNode,
} from "./map-nodes";

/**
 * Module constant: React Flow warns (and remounts every node) when the
 * `nodeTypes` object identity changes between renders.
 */
const FIT_VIEW_OPTIONS = { padding: 0.12 } as const;

/**
 * Frames the whole graph once React Flow has measured the custom nodes.
 *
 * The `fitView` prop (and an `onInit` call) both run before measurement, so a
 * tall column overflows the canvas. Card heights are content-driven — the agent
 * card's instructions block especially — so the server cannot supply exact
 * dimensions either; waiting for `useNodesInitialized` is the supported way.
 */
function FitWhenMeasured({ signature }: { signature: string }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (initialized) void fitView(FIT_VIEW_OPTIONS);
  }, [initialized, fitView, signature]);
  return null;
}

const NODE_TYPES = {
  triggers: TriggersNode,
  schedules: SchedulesNode,
  agent: AgentNode,
  model: ModelNode,
  toolbox: ToolboxNode,
  skills: SkillsNode,
  mcp_servers: McpServersNode,
  memory: MemoryNode,
} as const;

export function AgentMapView({
  packageId,
  version,
}: {
  packageId: string;
  version?: string | undefined;
}) {
  const { t } = useTranslation("agents");
  const { data, isLoading, error } = useAgentMap(packageId, version);
  const [editKind, setEditKind] = useState<MapEditKind | null>(null);

  // Stable identity: it rides in every node's `data`, which React Flow compares
  // to decide what to re-render.
  const onEdit = useCallback((kind: MapEditKind) => setEditKind(kind), []);

  // A system agent's definition ships with the platform and the API refuses the
  // write, and a pinned version is a frozen snapshot — neither is editable, so
  // no card offers an action it cannot deliver.
  const editable =
    data?.agent.source !== "system" && (data?.agent.version_ref ?? "draft") === "draft";

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    // Diagnostics ride into the node they belong to; row-level placement then
    // happens inside the renderer by `item_id`.
    const byNode = new Map<string, typeof data.diagnostics>();
    for (const d of data.diagnostics) {
      if (!d.node_id) continue;
      const list = byNode.get(d.node_id) ?? [];
      list.push(d);
      byNode.set(d.node_id, list);
    }
    return {
      nodes: data.nodes.map<Node>((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        // `agentPackageId` lets a card build its own links without the server
        // knowing anything about the SPA's routes; `onEdit` is what turns a card
        // header into an in-place edit affordance (absent ⇒ no affordance).
        data: {
          ...n.data,
          diagnostics: byNode.get(n.id) ?? [],
          agentPackageId: data.agent.packageId,
          ...(editable ? { onEdit } : {}),
        },
        draggable: false,
        // MUST stay selectable: React Flow gives a node `pointer-events: none`
        // unless it is selectable, draggable or connectable, which makes every
        // link and button inside it dead to a real click (a programmatic
        // `.click()` still fires, which is how this hid). Fleet's own nodes carry
        // `nopan selectable` for the same reason. Dragging stays off.
        selectable: true,
      })),
      edges: data.edges.map<Edge>((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        animated: true,
        style: { strokeDasharray: "4 4" },
      })),
    };
  }, [data, editable, onEdit]);

  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState message={t("map.loadError")} />;

  // Diagnostics with no node (an unrecognised readiness field) would otherwise
  // vanish from the UI — surface them above the canvas instead of dropping them.
  const orphanDiagnostics = data.diagnostics.filter((d) => !d.node_id);

  return (
    <div className="space-y-3">
      {/* Which definition is drawn, and how much of it is broken. Without this
          the reader cannot tell a draft map from an archived version's. */}
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span>
          {data.agent.version_ref === "draft"
            ? t("map.draftDefinition")
            : t("map.pinnedDefinition", { version: data.agent.version_ref })}
        </span>
        {data.diagnostics.length > 0 && (
          <span className="text-warning flex items-center gap-1">
            <AlertTriangle className="size-3.5" />
            {t("map.issueCount", { count: data.diagnostics.length })}
          </span>
        )}
      </div>
      {orphanDiagnostics.length > 0 && (
        <div className="border-warning/40 bg-warning/10 flex flex-col gap-1 rounded-lg border p-3">
          {orphanDiagnostics.map((d) => (
            <div key={d.field} className="flex items-center gap-2 text-xs">
              <AlertTriangle className="text-warning size-3.5 shrink-0" />
              <span>{d.message}</span>
            </div>
          ))}
        </div>
      )}
      {/* Viewport-relative rather than `100vh - header`: the page header varies
          (readiness alerts appear and disappear), and overshooting it pushes the
          canvas below the fold. */}
      <div className="border-border bg-muted/20 h-[60vh] min-h-[420px] rounded-lg border">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          // The app ships both themes (light default, dark toggle), so let
          // React Flow follow the OS/app preference instead of pinning one.
          colorMode="system"
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          minZoom={0.3}
          maxZoom={1.5}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
          <FitWhenMeasured signature={`${data.agent.packageId}@${data.agent.version_ref}`} />
        </ReactFlow>
      </div>
      <MapEditDialog kind={editKind} packageId={packageId} onClose={() => setEditKind(null)} />
    </div>
  );
}
