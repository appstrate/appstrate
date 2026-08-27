// SPDX-License-Identifier: Apache-2.0

/**
 * Agent visual map — the manifest and its installation state, drawn.
 *
 * The server computes the inventory and its diagnostics
 * (`GET /api/agents/{scope}/{name}/map`): the map must never disagree with what
 * a run would actually do. This prototype projects those facts into a stable
 * three-band reading order and progressively reveals the detailed resolution
 * edges when a configuration card is active.
 *
 * What IS shown is read-only; what it shows can be edited. Card headers open the
 * agent editor's own widgets in a dialog (see `map-edit-dialog.tsx`), which edit
 * the definition itself — the prompt as text, declared dependencies. The drawing
 * is never a source the definition gets generated from.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Panel,
  useReactFlow,
  useNodesState,
  useStore,
  useUpdateNodeInternals,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Maximize2, Minimize2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { useAgentMap } from "./use-agent-map";
import { ErrorState, LoadingState } from "../../components/page-states";
import { MapEditDialog, type MapEditKind } from "./map-edit-dialog";
import { MapIssuesDialog } from "./map-issues-dialog";
import { MapPanelDialog, type MapPanelKind } from "./map-panel-dialog";
import {
  AgentNode,
  BoundaryNode,
  ConnectionsNode,
  InputNode,
  InputValuesNode,
  McpServersNode,
  ModelNode,
  MemoryNode,
  OutputNode,
  SystemToolsNode,
  SchedulesNode,
  SkillsNode,
  ToolboxNode,
  ProxyNode,
} from "./map-nodes";

/**
 * Module constant: React Flow warns (and remounts every node) when the
 * `nodeTypes` object identity changes between renders.
 */
const FIT_VIEW_OPTIONS = { padding: 0.06, maxZoom: 1 } as const;

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
  boundary: BoundaryNode,
  schedules: SchedulesNode,
  connections: ConnectionsNode,
  input_values: InputValuesNode,
  // `agent_input` / `agent_output`, never `input` / `output`: React Flow reserves
  // those names for its built-in nodes and its stylesheet would draw its own box
  // behind ours (measured — `.react-flow__node-input` sets border + padding +
  // background). Same trap for `default` and `group`.
  agent_input: InputNode,
  agent: AgentNode,
  model: ModelNode,
  proxy: ProxyNode,
  agent_output: OutputNode,
  toolbox: ToolboxNode,
  skills: SkillsNode,
  mcp_servers: McpServersNode,
  system_tools: SystemToolsNode,
  memory: MemoryNode,
} as const;

const BOUNDARIES = [
  {
    id: "boundary-configuration",
    label: "boundaryConfiguration",
    description: "boundaryConfigurationDescription",
  },
  {
    id: "boundary-bundle",
    label: "boundaryBundle",
    description: "boundaryBundleDescription",
  },
  {
    id: "boundary-dependencies",
    label: "boundaryDependencies",
    description: "boundaryDependenciesDescription",
    tooltip: "boundaryDependenciesTooltip",
  },
  {
    id: "boundary-memory",
    label: "boundaryMemory",
    description: "boundaryMemoryDescription",
  },
] as const;

const CONFIG_CARD_IDS = ["connections", "input_values", "schedules", "model", "proxy"];
const BUNDLE_CARD_IDS = ["input", "agent", "output"];
const DEPENDENCY_CARD_ROWS = [
  ["toolbox", "skills"],
  ["mcp_servers", "system_tools"],
] as const;
const CARD_IDS = [...CONFIG_CARD_IDS, ...BUNDLE_CARD_IDS, ...DEPENDENCY_CARD_ROWS.flat(), "memory"];

const GROUP_HEADER_HEIGHT = 64;
const GROUP_PADDING = 24;
const CONFIG_GAP = 22;
const FLOW_GAP = 56;
const GRID_GAP = 24;
const GROUP_GAP = 60;
const BAND_GAP = 70;

type MeasuredSize = { width: number; height: number };

function layoutMeasuredNodes(nodes: Node[], sizes: Map<string, MeasuredSize>): Node[] {
  const size = (id: string) => sizes.get(id)!;
  const position = new Map<string, { x: number; y: number }>();
  const boundaries = new Map<string, { x: number; y: number; width: number; height: number }>();

  const configHeight = Math.max(...CONFIG_CARD_IDS.map((id) => size(id).height));
  const configWidth =
    GROUP_PADDING * 2 +
    CONFIG_CARD_IDS.reduce((total, id) => total + size(id).width, 0) +
    CONFIG_GAP * (CONFIG_CARD_IDS.length - 1);
  const configBoundaryHeight = GROUP_HEADER_HEIGHT + GROUP_PADDING + configHeight + GROUP_PADDING;

  const bundleMaxHeight = Math.max(...BUNDLE_CARD_IDS.map((id) => size(id).height));
  const bundleWidth =
    GROUP_PADDING * 2 +
    BUNDLE_CARD_IDS.reduce((total, id) => total + size(id).width, 0) +
    FLOW_GAP * (BUNDLE_CARD_IDS.length - 1);
  const bundleHeight = GROUP_HEADER_HEIGHT + GROUP_PADDING + bundleMaxHeight + GROUP_PADDING;

  const dependencyColumnWidths = [0, 1].map((column) =>
    Math.max(...DEPENDENCY_CARD_ROWS.map((row) => size(row[column]!).width)),
  );
  const dependencyRowHeights = DEPENDENCY_CARD_ROWS.map((row) =>
    Math.max(...row.map((id) => size(id).height)),
  );
  const dependencyWidth =
    GROUP_PADDING * 2 + dependencyColumnWidths[0]! + GRID_GAP + dependencyColumnWidths[1]!;
  const dependencyHeight =
    GROUP_HEADER_HEIGHT +
    GROUP_PADDING +
    dependencyRowHeights[0]! +
    GRID_GAP +
    dependencyRowHeights[1]! +
    GROUP_PADDING;

  const centralWidth = bundleWidth + GROUP_GAP + dependencyWidth;
  const centralHeight = Math.max(bundleHeight, dependencyHeight);
  const totalWidth = Math.max(configWidth, centralWidth, size("memory").width + GROUP_PADDING * 2);
  const configX = (totalWidth - configWidth) / 2;
  const centralY = configBoundaryHeight + BAND_GAP;
  const bundleX = 0;
  const dependencyX = bundleWidth + GROUP_GAP;
  const memoryY = centralY + centralHeight + BAND_GAP;
  const memoryHeight = GROUP_HEADER_HEIGHT + GROUP_PADDING + size("memory").height + GROUP_PADDING;

  boundaries.set("boundary-configuration", {
    x: configX,
    y: 0,
    width: configWidth,
    height: configBoundaryHeight,
  });
  boundaries.set("boundary-bundle", {
    x: bundleX,
    y: centralY,
    width: bundleWidth,
    height: bundleHeight,
  });
  boundaries.set("boundary-dependencies", {
    x: dependencyX,
    y: centralY,
    width: dependencyWidth,
    height: dependencyHeight,
  });
  boundaries.set("boundary-memory", {
    x: 0,
    y: memoryY,
    width: totalWidth,
    height: memoryHeight,
  });

  let configCardX = configX + GROUP_PADDING;
  for (const id of CONFIG_CARD_IDS) {
    position.set(id, {
      x: configCardX,
      y: GROUP_HEADER_HEIGHT + GROUP_PADDING + (configHeight - size(id).height) / 2,
    });
    configCardX += size(id).width + CONFIG_GAP;
  }

  let bundleCardX = bundleX + GROUP_PADDING;
  for (const id of BUNDLE_CARD_IDS) {
    position.set(id, {
      x: bundleCardX,
      y: centralY + GROUP_HEADER_HEIGHT + GROUP_PADDING + (bundleMaxHeight - size(id).height) / 2,
    });
    bundleCardX += size(id).width + FLOW_GAP;
  }

  let dependencyRowY = centralY + GROUP_HEADER_HEIGHT + GROUP_PADDING;
  for (const [rowIndex, row] of DEPENDENCY_CARD_ROWS.entries()) {
    let dependencyCardX = dependencyX + GROUP_PADDING;
    for (const [columnIndex, id] of row.entries()) {
      position.set(id, {
        x: dependencyCardX + (dependencyColumnWidths[columnIndex]! - size(id).width) / 2,
        y: dependencyRowY + (dependencyRowHeights[rowIndex]! - size(id).height) / 2,
      });
      dependencyCardX += dependencyColumnWidths[columnIndex]! + GRID_GAP;
    }
    dependencyRowY += dependencyRowHeights[rowIndex]! + GRID_GAP;
  }

  position.set("memory", {
    x: (totalWidth - size("memory").width) / 2,
    y: memoryY + GROUP_HEADER_HEIGHT + GROUP_PADDING,
  });

  return nodes.map((node) => {
    const boundary = boundaries.get(node.id);
    if (boundary) {
      return {
        ...node,
        position: { x: boundary.x, y: boundary.y },
        style: { ...node.style, width: boundary.width, height: boundary.height },
      };
    }
    const nextPosition = position.get(node.id);
    return nextPosition ? { ...node, position: nextPosition } : node;
  });
}

function MeasuredSemanticLayout({
  layoutKey,
  setNodes,
}: {
  layoutKey: string;
  setNodes: Dispatch<SetStateAction<Node[]>>;
}) {
  const measurementSignature = useStore((state) =>
    CARD_IDS.map((id) => {
      const measured = state.nodeLookup.get(id)?.measured;
      return `${id}:${measured?.width ?? 0}x${measured?.height ?? 0}`;
    }).join("|"),
  );
  const laidOutSignature = useRef<string | null>(null);
  const { fitView } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();

  useEffect(() => {
    const signature = `${layoutKey}|${measurementSignature}`;
    if (signature === laidOutSignature.current) return;
    const parsedSizes = new Map<string, MeasuredSize>();
    for (const token of measurementSignature.split("|")) {
      const [id, dimensions] = token.split(":");
      const [width, height] = dimensions!.split("x").map(Number);
      if (!id || !width || !height) return;
      parsedSizes.set(id, { width, height });
    }
    laidOutSignature.current = signature;
    setNodes((current) => layoutMeasuredNodes(current, parsedSizes));
    requestAnimationFrame(() => {
      updateNodeInternals([...CARD_IDS, ...BOUNDARIES.map((boundary) => boundary.id)]);
      requestAnimationFrame(() => void fitView(FIT_VIEW_OPTIONS));
    });
  }, [fitView, layoutKey, measurementSignature, setNodes, updateNodeInternals]);

  return null;
}

const CONFIG_RELATION_IDS = new Set(["connections", "input_values", "schedules", "model", "proxy"]);

function projectedEdge(edge: Edge): Edge {
  if (edge.id === "input->agent" || edge.id === "agent->output") {
    return {
      ...edge,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--foreground)" },
      animated: false,
      style: { stroke: "var(--foreground)", strokeWidth: 3 },
      zIndex: 3,
    };
  }
  if (edge.id.startsWith("dependency-")) {
    return {
      ...edge,
      type: "smoothstep",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "var(--muted-foreground)",
        width: 12,
        height: 12,
      },
      animated: false,
      style: {
        stroke: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)",
        strokeWidth: 1.25,
      },
      zIndex: 3,
    };
  }
  return {
    ...edge,
    type: "smoothstep",
    animated: false,
    ...(edge.id === "resolution-memory"
      ? {
          markerStart: {
            type: MarkerType.ArrowClosed,
            color: "var(--muted-foreground)",
            width: 14,
            height: 14,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "var(--muted-foreground)",
            width: 14,
            height: 14,
          },
        }
      : {
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "var(--muted-foreground)",
            width: 12,
            height: 12,
          },
        }),
    style: {
      stroke: "var(--muted-foreground)",
      strokeWidth: 1.75,
      strokeDasharray: "7 5",
    },
    zIndex: 3,
  };
}

export function AgentMapView({
  packageId,
  version,
}: {
  packageId: string;
  version?: string | undefined;
}) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const { data, isLoading, error } = useAgentMap(packageId, version);
  const [editKind, setEditKind] = useState<MapEditKind | null>(null);
  const [panelKind, setPanelKind] = useState<MapPanelKind | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hoveredRelation, setHoveredRelation] = useState<string | null>(null);
  const [selectedRelation, setSelectedRelation] = useState<string | null>(null);
  const activeRelation = hoveredRelation ?? selectedRelation;
  const collapse = useCallback(() => setExpanded(false), []);
  useEscape(expanded, collapse);

  // Stable identity: it rides in every node's `data`, which React Flow compares
  // to decide what to re-render.
  const onEdit = useCallback((kind: MapEditKind) => setEditKind(kind), []);
  const onPanel = useCallback((kind: MapPanelKind) => setPanelKind(kind), []);
  const onRelationActive = useCallback((relationId: string | null) => {
    setHoveredRelation(relationId);
  }, []);

  // A system agent's definition ships with the platform and the API refuses the
  // write, and a pinned version is a frozen snapshot — neither is editable, so
  // no card offers an action it cannot deliver.
  const editable =
    data?.agent.source !== "system" && (data?.agent.version_ref ?? "draft") === "draft";

  const projectedNodes = useMemo(() => {
    if (!data) return [] as Node[];
    // Diagnostics ride into the node they belong to; row-level placement then
    // happens inside the renderer by `item_id`.
    const byNode = new Map<string, typeof data.diagnostics>();
    for (const d of data.diagnostics) {
      if (!d.node_id) continue;
      const list = byNode.get(d.node_id) ?? [];
      list.push(d);
      byNode.set(d.node_id, list);
    }
    const cards = data.nodes.map<Node>((n) => ({
      id: n.id,
      type: n.type,
      // Cards first mount at a harmless staging point so React Flow can measure
      // their real rendered dimensions. `MeasuredSemanticLayout` then assigns
      // the deterministic semantic layout exactly once for that measurement.
      position: { x: 0, y: 0 },
      // `onEdit`/`onPanel` are what turn a card header into an affordance;
      // absent ⇒ no affordance, which is how a system package or a pinned
      // version ends up read-only without the cards knowing why.
      data: {
        ...n.data,
        diagnostics: byNode.get(n.id) ?? [],
        onPanel,
        onRelationActive,
        ...(editable ? { onEdit } : {}),
      },
      draggable: false,
      // MUST stay selectable: React Flow gives a node `pointer-events: none`
      // unless it is selectable, draggable or connectable, which makes every
      // link and button inside it dead to a real click (a programmatic
      // `.click()` still fires, which is how this hid). Fleet's own nodes carry
      // `nopan selectable` for the same reason. Dragging stays off.
      selectable: true,
      zIndex: 4,
    }));
    const boundaries = BOUNDARIES.map<Node>((boundary) => ({
      id: boundary.id,
      type: "boundary",
      position: { x: 0, y: 0 },
      style: { width: 1, height: 1 },
      data: {
        label: t(`agent-map:${boundary.label}`),
        description: t(`agent-map:${boundary.description}`),
        ...("tooltip" in boundary && boundary.tooltip
          ? { tooltip: t(`agent-map:${boundary.tooltip}`) }
          : {}),
      },
      draggable: false,
      selectable: "tooltip" in boundary && Boolean(boundary.tooltip),
      zIndex: 0,
    }));
    return [...boundaries, ...cards];
  }, [data, editable, onEdit, onPanel, onRelationActive, t]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  useEffect(() => {
    setNodes((current) => {
      const currentById = new Map(current.map((node) => [node.id, node]));
      return projectedNodes.map((node) => {
        const existing = currentById.get(node.id);
        if (!existing) return node;
        return {
          ...node,
          position: existing.position,
          ...(node.type === "boundary" ? { style: existing.style } : {}),
          selected: existing.selected,
        };
      });
    });
  }, [projectedNodes, setNodes]);

  const layoutKey = `${packageId}:${version ?? "draft"}:${projectedNodes
    .map((node) => node.id)
    .join(",")}`;

  const edges = useMemo(() => {
    const labelled = (edge: Edge, label: string): Edge => ({
      ...edge,
      label,
      labelStyle: {
        fill: "var(--muted-foreground)",
        fontSize: 11,
        fontWeight: 700,
      },
      labelBgStyle: {
        fill: "var(--card)",
        fillOpacity: 1,
        stroke: "var(--border)",
        strokeWidth: 1,
      },
      labelBgPadding: [8, 5],
      labelBgBorderRadius: 6,
    });
    const genericEdges: Edge[] = [
      projectedEdge({
        id: "input->agent",
        source: "input",
        target: "agent",
        sourceHandle: "right",
        targetHandle: "left",
      }),
      projectedEdge({
        id: "agent->output",
        source: "agent",
        target: "output",
        sourceHandle: "right",
        targetHandle: "left",
      }),
      projectedEdge(
        labelled(
          {
            id: "dependency-group",
            source: "boundary-dependencies",
            target: "boundary-bundle",
            sourceHandle: "s-left",
            targetHandle: "t-right",
          },
          t("agent-map:relationProvidesCapabilities"),
        ),
      ),
      projectedEdge(
        labelled(
          {
            id: "resolution-memory",
            source: "boundary-bundle",
            target: "boundary-memory",
            sourceHandle: "s-bottom",
            targetHandle: "t-top",
          },
          t("agent-map:relationReadsWritesMemory"),
        ),
      ),
    ];
    const detailedRelation: Record<string, Edge> = {
      connections: {
        id: "resolution-detail-connections",
        source: "connections",
        target: "toolbox",
        sourceHandle: "bottom",
        targetHandle: "top",
      },
      input_values: {
        id: "resolution-detail-input-values",
        source: "input_values",
        target: "input",
        sourceHandle: "bottom",
        targetHandle: "top",
      },
      schedules: {
        id: "resolution-detail-schedules",
        source: "schedules",
        target: "agent",
        sourceHandle: "bottom",
        targetHandle: "top",
      },
      model: {
        id: "resolution-detail-model",
        source: "model",
        target: "agent",
        sourceHandle: "bottom",
        targetHandle: "top",
      },
      proxy: {
        id: "resolution-detail-proxy",
        source: "proxy",
        target: "agent",
        sourceHandle: "bottom",
        targetHandle: "top",
      },
    };
    const configEdge = activeRelation
      ? detailedRelation[activeRelation]
      : labelled(
          {
            id: "resolution-group-configuration",
            source: "boundary-configuration",
            target: "boundary-bundle",
            sourceHandle: "s-bottom",
            targetHandle: "t-top",
          },
          t("agent-map:relationConfigures"),
        );
    return [...genericEdges, ...(configEdge ? [projectedEdge(configEdge)] : [])];
  }, [activeRelation, t]);

  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState message={t("agent-map:loadError")} />;

  // Diagnostics with no node (an unrecognised readiness field) would otherwise
  // vanish from the UI — surface them above the canvas instead of dropping them.
  const orphanDiagnostics = data.diagnostics.filter((d) => !d.node_id);

  return (
    <div
      className={
        expanded ? "bg-background fixed inset-0 z-50 flex flex-col gap-3 p-4" : "space-y-3"
      }
    >
      {/* Which definition is drawn and how much of it is broken. Fullscreen is
          a canvas control and therefore lives beside the React Flow controls. */}
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span>
          {data.agent.version_ref === "draft"
            ? t("agent-map:draftDefinition")
            : t("agent-map:pinnedDefinition", {
                version: data.agent.version_ref,
              })}
        </span>
        {data.diagnostics.length > 0 && (
          <button
            type="button"
            onClick={() => setIssuesOpen(true)}
            className="text-warning hover:text-warning/80 flex items-center gap-1 underline-offset-2 hover:underline"
          >
            <AlertTriangle className="size-3.5" />
            {t("agent-map:issueCount", { count: data.diagnostics.length })}
          </button>
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
      {/* Expanded: fill what is left of the overlay. Otherwise viewport-relative
          rather than a viewport subtraction because the page header varies (readiness alerts
          appear and disappear) and overshooting pushes the canvas below the fold. */}
      <section
        className={`border-border bg-muted/20 [&_.selected_.agent-map-card]:ring-primary flex flex-col overflow-hidden rounded-lg border [&_.selected_.agent-map-card]:ring-2 [&_.selected_.agent-map-card]:ring-offset-2 ${
          expanded ? "min-h-0 flex-1" : "h-[60vh] min-h-[420px]"
        }`}
      >
        <div className="min-h-0 flex-1">
          <ReactFlow
            nodes={nodes}
            onNodesChange={onNodesChange}
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
            defaultEdgeOptions={{ zIndex: 3 }}
            minZoom={0.3}
            maxZoom={1.5}
            panOnScroll
            zoomOnScroll={false}
            onNodeClick={(_event, node) => {
              if (!CONFIG_RELATION_IDS.has(node.id)) return;
              setSelectedRelation((current) => (current === node.id ? null : node.id));
            }}
            onPaneClick={() => setSelectedRelation(null)}
          >
            <Background gap={24} size={1} />
            <Controls position="top-right" showInteractive={false} style={{ top: 34 }} />
            <Panel position="top-right">
              <TooltipProvider delayDuration={250}>
                <Tooltip>
                  <div className="react-flow__controls">
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="react-flow__controls-button"
                        onClick={() => setExpanded((value) => !value)}
                        aria-label={expanded ? t("agent-map:collapse") : t("agent-map:expand")}
                      >
                        {expanded ? <Minimize2 /> : <Maximize2 />}
                      </button>
                    </TooltipTrigger>
                  </div>
                  <TooltipContent side="left">
                    {expanded ? t("agent-map:collapse") : t("agent-map:expand")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </Panel>
            <FitOnCanvasResize />
            <MeasuredSemanticLayout layoutKey={layoutKey} setNodes={setNodes} />
          </ReactFlow>
        </div>
        <footer className="bg-background border-border shrink-0 overflow-x-auto border-t px-4 py-3">
          <div className="text-muted-foreground flex min-w-max items-center gap-6 text-[11px]">
            <span className="flex items-center gap-2">
              <span className="bg-foreground h-0.5 w-7" />
              {t("agent-map:legendFlow")}
            </span>
            <span className="flex items-center gap-2">
              <span className="bg-muted-foreground/70 h-px w-7" />
              {t("agent-map:legendDependency")}
            </span>
            <span className="flex items-center gap-2">
              <span className="border-muted-foreground w-7 border-t border-dashed" />
              {t("agent-map:legendResolution")}
            </span>
          </div>
        </footer>
      </section>
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
