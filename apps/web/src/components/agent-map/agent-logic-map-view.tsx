// SPDX-License-Identifier: Apache-2.0

/**
 * Renderer for the agent logic map.
 *
 * Same wire contract and same library as the dependency map — positioned nodes
 * and edges computed server-side, React Flow drawing them — but a different
 * nature, and the UI has to say so. This map is INFERRED from free text: it can
 * be absent, it can be stale, and it can be wrong. Hence the permanent banner,
 * the confidence, and the per-step evidence anchor.
 *
 * Nothing here is editable. Making a logic map editable would turn it into a
 * visual workflow builder, which contradicts the whole point: the prompt is the
 * source of truth, the map is a reading of it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, Maximize2, Minimize2 } from "lucide-react";
import { useAgentLogicMap } from "../../hooks/use-agent-logic-map";
import { EmptyState, ErrorState, LoadingState } from "../page-states";
import {
  DecisionNode,
  EmitNode,
  GuardNode,
  LoopNode,
  PolicyNode,
  StepNode,
  ToolCallNode,
} from "./logic-map-nodes";

const FIT_VIEW_OPTIONS = { padding: 0.1, minZoom: 0.05 } as const;

/** React Flow demands a stable identity, so this lives at module scope. */
const NODE_TYPES = {
  step: StepNode,
  decision: DecisionNode,
  loop: LoopNode,
  tool_call: ToolCallNode,
  guard: GuardNode,
  policy: PolicyNode,
  emit: EmitNode,
} as const;

/**
 * Cadre la vue UNE FOIS les nœuds mesurés.
 *
 * La prop `fitView` seule cadre au premier rendu, quand les cartes n'ont pas encore
 * de hauteur : sur une carte de logique, qui en empile des dizaines, le cadrage se
 * calcule alors sur des tailles nulles. `useNodesInitialized` est le signal que
 * React Flow expose exactement pour ça.
 */
function FitWhenMeasured({ signature }: { signature: string }) {
  const initialised = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!initialised) return;
    const id = requestAnimationFrame(() => void fitView(FIT_VIEW_OPTIONS));
    return () => cancelAnimationFrame(id);
  }, [initialised, fitView, signature]);
  return null;
}

export function AgentLogicMapView({
  packageId,
  version,
}: {
  packageId: string;
  version?: string | undefined;
}) {
  const { t } = useTranslation("agents");
  const { data, isLoading, error } = useAgentLogicMap(packageId, version);
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const { nodes, edges } = useMemo(() => {
    if (!data?.map) return { nodes: [] as Node[], edges: [] as Edge[] };
    // Les constats arrivent déjà routés vers l'étape qu'ils concernent : le rendu
    // ne fait qu'un regroupement, jamais un recalcul.
    const byStep = new Map<string, typeof data.diagnostics>();
    for (const d of data.diagnostics) {
      for (const stepId of d.step_ids) {
        const list = byStep.get(stepId) ?? [];
        list.push(d);
        byStep.set(stepId, list);
      }
    }
    const steps = new Map(
      ((data.map as { steps?: Record<string, unknown>[] }).steps ?? []).map((s) => [
        s["id"] as string,
        s,
      ]),
    );
    return {
      nodes: data.nodes.map<Node>((n) => {
        const step = steps.get(n.id) ?? {};
        return {
          id: n.id,
          type: n.type,
          position: n.position,
          data: {
            label: step["label"] ?? n.id,
            detail: step["detail"] ?? null,
            refs: step["refs"] ?? [],
            evidence: step["evidence"] ?? null,
            confidence: step["confidence"] ?? null,
            aggregated: step["aggregated"] ?? false,
            terminal: step["terminal"] ?? false,
            until: step["until"] ?? null,
            depth: n.depth,
            diagnostics: byStep.get(n.id) ?? [],
          },
          draggable: false,
        };
      }),
      edges: data.edges.map<Edge>((e, i) => ({
        id: `${e.from}->${e.to}-${i}`,
        source: e.from,
        target: e.to,
        ...(e.condition ? { label: e.condition } : {}),
        animated: false,
      })),
    };
  }, [data]);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={String(error)} />;
  if (!data) return null;

  // Avant que quoi que ce soit ait cartographié cette version. Ce n'est pas une
  // erreur : c'est l'état normal d'un agent que personne n'a encore lu.
  if (!data.map) {
    return (
      <EmptyState icon={Info} message={t("logicMap.empty.title")} hint={t("logicMap.empty.body")} />
    );
  }

  const confidence = data.meta.overall_confidence;

  return (
    <div className={expanded ? "fixed inset-0 z-50 bg-neutral-950 p-4" : "relative"}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="flex items-center gap-1.5 rounded bg-neutral-900 px-2 py-1 text-neutral-400">
          <Info className="h-3.5 w-3.5" aria-hidden />
          {t("logicMap.inferredBadge")}
        </span>
        {typeof confidence === "number" && (
          <span className="rounded bg-neutral-900 px-2 py-1 text-neutral-400">
            {t("logicMap.confidence", { percent: Math.round(confidence * 100) })}
          </span>
        )}
        {data.meta.stale && (
          <span className="flex items-center gap-1.5 rounded bg-amber-950 px-2 py-1 text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            {t("logicMap.stale")}
          </span>
        )}
        <button
          type="button"
          onClick={toggle}
          className="ml-auto rounded p-1 text-neutral-400 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          aria-label={t(expanded ? "logicMap.collapse" : "logicMap.expand")}
        >
          {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>

      <div className={expanded ? "h-[calc(100%-2.5rem)]" : "h-[70vh] min-h-[520px]"}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
            <FitWhenMeasured signature={`${packageId}:${nodes.length}`} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}
