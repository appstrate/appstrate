// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Background,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Maximize2, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { AgentMapBoundaryNode, AgentMapCardNode } from "./map-nodes";

export type AgentMapIcon =
  | "agent"
  | "connection"
  | "input"
  | "integration"
  | "mcp"
  | "memory"
  | "model"
  | "output"
  | "proxy"
  | "schedule"
  | "skill"
  | "tools"
  | "values";

export interface AgentMapCard {
  id: string;
  title: string;
  value: string;
  description?: string | undefined;
  icon: AgentMapIcon;
  href?: string | undefined;
  onActivate?: (() => void) | undefined;
  warning?: string | undefined;
}

export interface InstalledAgentMap {
  configuration: {
    schedules: AgentMapCard;
    model: AgentMapCard;
    inputValues: AgentMapCard;
    proxy: AgentMapCard;
    connections: AgentMapCard;
  };
  bundle: {
    input: AgentMapCard;
    agent: AgentMapCard;
    output: AgentMapCard;
    integrations: AgentMapCard;
    skills: AgentMapCard;
    mcpServers: AgentMapCard;
    systemTools: AgentMapCard;
  };
  memory: AgentMapCard;
  scheduleActive: boolean;
}

type BoundaryData = Record<string, unknown> & {
  label: string;
  description: string;
};

type CardData = AgentMapCard &
  Record<string, unknown> & {
    actionLabel: string;
    wide?: boolean | undefined;
  };

const NODE_TYPES = {
  boundary: AgentMapBoundaryNode,
  card: AgentMapCardNode,
};

const FIT_VIEW_OPTIONS = { padding: 0.08, maxZoom: 1 } as const;

function FitOnCanvasResize() {
  const canvasSize = useStore((state) => `${Math.round(state.width)}x${Math.round(state.height)}`);
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (canvasSize === "0x0") return;
    void fitView(FIT_VIEW_OPTIONS);
  }, [canvasSize, fitView]);

  return null;
}

function useEscape(active: boolean, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, close]);
}

const CARD_X = {
  configuration: 28,
  flow: 416,
  dependencies: 912,
} as const;

function buildNodes(
  map: InstalledAgentMap,
  labels: {
    configuration: BoundaryData;
    bundle: BoundaryData;
    memory: BoundaryData;
    open: string;
  },
): Node<BoundaryData | CardData>[] {
  const card = (
    data: AgentMapCard,
    position: { x: number; y: number },
    options?: { wide?: boolean },
  ): Node<CardData> => ({
    id: data.id,
    type: "card",
    position,
    data: { ...data, actionLabel: labels.open, wide: options?.wide },
    draggable: false,
    selectable: true,
    zIndex: 2,
  });

  return [
    {
      id: "boundary-configuration",
      type: "boundary",
      position: { x: 0, y: 0 },
      data: labels.configuration,
      style: { width: 336, height: 794 },
      draggable: false,
      selectable: false,
      zIndex: 0,
    },
    {
      id: "boundary-bundle",
      type: "boundary",
      position: { x: 372, y: 0 },
      data: labels.bundle,
      style: { width: 878, height: 794 },
      draggable: false,
      selectable: false,
      zIndex: 0,
    },
    {
      id: "boundary-memory",
      type: "boundary",
      position: { x: 0, y: 824 },
      data: labels.memory,
      style: { width: 1250, height: 180 },
      draggable: false,
      selectable: false,
      zIndex: 0,
    },
    card(map.configuration.connections, { x: CARD_X.configuration, y: 88 }),
    card(map.configuration.inputValues, { x: CARD_X.configuration, y: 224 }),
    card(map.configuration.schedules, { x: CARD_X.configuration, y: 360 }),
    card(map.configuration.model, { x: CARD_X.configuration, y: 496 }),
    card(map.configuration.proxy, { x: CARD_X.configuration, y: 632 }),
    card(map.bundle.input, { x: CARD_X.flow, y: 92 }, { wide: true }),
    card(map.bundle.agent, { x: CARD_X.flow, y: 326 }, { wide: true }),
    card(map.bundle.output, { x: CARD_X.flow, y: 610 }, { wide: true }),
    card(map.bundle.integrations, { x: CARD_X.dependencies, y: 88 }),
    card(map.bundle.skills, { x: CARD_X.dependencies, y: 224 }),
    card(map.bundle.mcpServers, { x: CARD_X.dependencies, y: 360 }),
    card(map.bundle.systemTools, { x: CARD_X.dependencies, y: 496 }),
    card(map.memory, { x: 28, y: 894 }, { wide: true }),
  ];
}

function buildEdges(map: InstalledAgentMap, reduceMotion: boolean): Edge[] {
  const flow = (id: string, source: string, target: string): Edge => ({
    id,
    source,
    target,
    sourceHandle: "bottom",
    targetHandle: "top",
    type: "straight",
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "var(--foreground)",
      width: 18,
      height: 18,
    },
    style: { stroke: "var(--foreground)", strokeWidth: 3 },
    zIndex: 4,
  });
  const dependency = (id: string, target: string, sourceHandle: string): Edge => ({
    id,
    source: map.bundle.agent.id,
    target,
    sourceHandle,
    targetHandle: "left",
    type: "bezier",
    style: {
      stroke: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)",
      strokeWidth: 1.25,
    },
    zIndex: 1,
  });
  const resolution = (
    id: string,
    source: string,
    target: string,
    options?: {
      sourceHandle?: "right" | "bottom";
      targetHandle?: string;
      active?: boolean;
    },
  ): Edge => ({
    id,
    source,
    target,
    sourceHandle: options?.sourceHandle ?? "right",
    targetHandle: options?.targetHandle ?? "left",
    type: "bezier",
    animated: (options?.active ?? false) && !reduceMotion,
    style: {
      stroke: "var(--muted-foreground)",
      strokeWidth: 1.75,
      strokeDasharray: "7 5",
    },
    zIndex: 1,
  });

  return [
    flow("flow-input-agent", map.bundle.input.id, map.bundle.agent.id),
    flow("flow-agent-output", map.bundle.agent.id, map.bundle.output.id),
    dependency("dependency-integrations", map.bundle.integrations.id, "right-1"),
    dependency("dependency-skills", map.bundle.skills.id, "right-2"),
    dependency("dependency-mcp", map.bundle.mcpServers.id, "right-3"),
    dependency("dependency-tools", map.bundle.systemTools.id, "right-4"),
    resolution("resolution-schedule", map.configuration.schedules.id, map.bundle.agent.id, {
      active: map.scheduleActive,
      targetHandle: "left-upper",
    }),
    resolution("resolution-model", map.configuration.model.id, map.bundle.agent.id),
    resolution("resolution-input-values", map.configuration.inputValues.id, map.bundle.input.id),
    resolution("resolution-proxy", map.configuration.proxy.id, map.bundle.agent.id, {
      targetHandle: "left-lower",
    }),
    resolution(
      "resolution-connections",
      map.configuration.connections.id,
      map.bundle.integrations.id,
    ),
  ];
}

export function AgentMapView({
  map,
  embedded = false,
  footer,
}: {
  map: InstalledAgentMap;
  embedded?: boolean;
  footer?: ReactNode;
}) {
  const { t } = useTranslation("agents");
  const [expanded, setExpanded] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const collapse = useCallback(() => setExpanded(false), []);
  useEscape(expanded, collapse);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const nodes = useMemo(
    () =>
      buildNodes(map, {
        configuration: {
          label: t("detail.overview.appstrateConfiguration"),
          description: t("detail.overview.appstrateConfigurationDescription"),
        },
        bundle: {
          label: t("detail.overview.portableBundle"),
          description: t("detail.overview.portableBundleDescription"),
        },
        memory: {
          label: t("detail.overview.appstrateMemory"),
          description: t("detail.overview.appstrateMemoryDescription"),
        },
        open: t("detail.overview.open"),
      }),
    [map, t],
  );
  const edges = useMemo(() => buildEdges(map, reduceMotion), [map, reduceMotion]);

  return (
    <section
      className={cn(
        "bg-background flex flex-col overflow-hidden rounded-xl border",
        embedded && "rounded-none border-0",
        expanded && "fixed inset-3 z-50 flex flex-col overflow-hidden shadow-2xl",
      )}
      data-agent-map
    >
      <div
        className={cn(
          "min-h-0",
          expanded
            ? "flex-1"
            : embedded
              ? "h-[clamp(520px,56vh,580px)]"
              : "h-[64vh] min-h-[560px]",
        )}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          edgesFocusable={false}
          minZoom={0.35}
          maxZoom={1.5}
          panOnScroll
          zoomOnScroll={false}
          proOptions={{ hideAttribution: true }}
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
                      aria-label={
                        expanded
                          ? t("detail.overview.exitFullscreen")
                          : t("detail.overview.enterFullscreen")
                      }
                    >
                      {expanded ? <Minimize2 /> : <Maximize2 />}
                    </button>
                  </TooltipTrigger>
                </div>
                <TooltipContent side="left">
                  {expanded
                    ? t("detail.overview.exitFullscreen")
                    : t("detail.overview.enterFullscreen")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </Panel>
          <FitOnCanvasResize />
        </ReactFlow>
      </div>
      {footer && (
        <footer
          className={cn(
            "bg-card border-border shrink-0 overflow-x-auto border-t px-4",
            expanded || !embedded ? "py-3" : "flex h-9 items-center py-0",
          )}
          data-agent-map-footer
        >
          {footer}
        </footer>
      )}
    </section>
  );
}
