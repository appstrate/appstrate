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
  useReactFlow,
  useStore,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Maximize2, Minimize2 } from "lucide-react";
import { useAgentMap } from "../../hooks/use-agent-map";
import { ErrorState, LoadingState } from "../page-states";
import { MapEditDialog, type MapEditKind } from "./map-edit-dialog";
import { MapIssuesDialog } from "./map-issues-dialog";
import { MapPanelDialog, type MapPanelKind } from "./map-panel-dialog";
import {
  AgentNode,
  InputNode,
  McpServersNode,
  ModelNode,
  OutputNode,
  SystemToolsNode,
  SchedulesNode,
  SkillsNode,
  ToolboxNode,
} from "./map-nodes";

/**
 * Module constant: React Flow warns (and remounts every node) when the
 * `nodeTypes` object identity changes between renders.
 */
const FIT_VIEW_OPTIONS = { padding: 0.12 } as const;

/**
 * Re-frames the graph whenever the canvas changes size: expanding to full
 * screen, resizing the window, collapsing the sidebar.
 *
 * Keyed on the STORE's width/height, not on the expand flag nor a DOM
 * ResizeObserver, because `fitView` frames against those store values and React
 * Flow only writes them after its own measurement pass — reacting any earlier
 * fits against stale numbers and silently leaves the zoom untouched.
 *
 * Note it does NOT gate on `useNodesInitialized()`: with these nodes that hook
 * stays false indefinitely, so gating on it means never fitting at all (measured
 * — an earlier version of this component did exactly that and did nothing).
 * The FIRST frame is handled by React Flow's own `fitView` prop.
 */
function FitOnCanvasResize() {
  const canvasSize = useStore((s) => `${Math.round(s.width)}x${Math.round(s.height)}`);
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (canvasSize === "0x0") return; // bootstrap frame, nothing measured yet
    void fitView(FIT_VIEW_OPTIONS);
  }, [fitView, canvasSize]);
  return null;
}

/** Escape leaves the expanded canvas — the same reflex as any overlay. */
function useEscape(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onEscape]);
}

const NODE_TYPES = {
  schedules: SchedulesNode,
  // `agent_input` / `agent_output`, never `input` / `output`: React Flow reserves
  // those names for its built-in nodes and its stylesheet would draw its own box
  // behind ours (measured — `.react-flow__node-input` sets border + padding +
  // background). Same trap for `default` and `group`.
  agent_input: InputNode,
  agent: AgentNode,
  model: ModelNode,
  agent_output: OutputNode,
  toolbox: ToolboxNode,
  skills: SkillsNode,
  mcp_servers: McpServersNode,
  system_tools: SystemToolsNode,
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
  const [panelKind, setPanelKind] = useState<MapPanelKind | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapse = useCallback(() => setExpanded(false), []);
  useEscape(expanded, collapse);

  // Stable identity: it rides in every node's `data`, which React Flow compares
  // to decide what to re-render.
  const onEdit = useCallback((kind: MapEditKind) => setEditKind(kind), []);
  const onPanel = useCallback((kind: MapPanelKind) => setPanelKind(kind), []);

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
        // `onEdit`/`onPanel` are what turn a card header into an affordance;
        // absent ⇒ no affordance, which is how a system package or a pinned
        // version ends up read-only without the cards knowing why.
        data: {
          ...n.data,
          diagnostics: byNode.get(n.id) ?? [],
          onPanel,
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
        // The agent carries a handle on each of its four sides, so an edge that
        // does not name the one it means is dropped without a word.
        sourceHandle: e.source_handle,
        targetHandle: e.target_handle,
        animated: true,
        style: { strokeDasharray: "4 4" },
      })),
    };
  }, [data, editable, onEdit, onPanel]);

  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState message={t("map.loadError")} />;

  // Diagnostics with no node (an unrecognised readiness field) would otherwise
  // vanish from the UI — surface them above the canvas instead of dropping them.
  const orphanDiagnostics = data.diagnostics.filter((d) => !d.node_id);

  return (
    <div
      className={
        expanded ? "bg-background fixed inset-0 z-50 flex flex-col gap-3 p-4" : "space-y-3"
      }
    >
      {/* Which definition is drawn, how much of it is broken, and the way out of
          the expanded canvas. Without the first the reader cannot tell a draft
          map from an archived version's. */}
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span>
          {data.agent.version_ref === "draft"
            ? t("map.draftDefinition")
            : t("map.pinnedDefinition", { version: data.agent.version_ref })}
        </span>
        {data.diagnostics.length > 0 && (
          <button
            type="button"
            onClick={() => setIssuesOpen(true)}
            className="text-warning hover:text-warning/80 flex items-center gap-1 underline-offset-2 hover:underline"
          >
            <AlertTriangle className="size-3.5" />
            {t("map.issueCount", { count: data.diagnostics.length })}
          </button>
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="hover:text-foreground ml-auto flex items-center gap-1 transition-colors"
        >
          {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          {expanded ? t("map.collapse") : t("map.expand")}
        </button>
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
      {/* Expanded: fill what is left of the overlay. Otherwise viewport-relative
          rather than `100vh - header` — the page header varies (readiness alerts
          appear and disappear) and overshooting pushes the canvas below the fold. */}
      <div
        className={`border-border bg-muted/20 rounded-lg border ${
          expanded ? "min-h-0 flex-1" : "h-[60vh] min-h-[420px]"
        }`}
      >
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
          <FitOnCanvasResize />
        </ReactFlow>
      </div>
      <MapIssuesDialog
        diagnostics={issuesOpen ? data.diagnostics : null}
        onEdit={onEdit}
        onPanel={onPanel}
        onClose={() => setIssuesOpen(false)}
      />
      <MapEditDialog kind={editKind} packageId={packageId} onClose={() => setEditKind(null)} />
      <MapPanelDialog kind={panelKind} packageId={packageId} onClose={() => setPanelKind(null)} />
    </div>
  );
}
