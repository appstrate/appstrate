// SPDX-License-Identifier: Apache-2.0

/**
 * Node renderers for the agent logic map.
 *
 * One component per step kind of the closed vocabulary. They render what the
 * server sends and add no verdict of their own — the cross-check already routed
 * every finding to the step it belongs to.
 *
 * The single interaction that matters is the evidence anchor: clicking a step
 * reveals the exact quote it was derived from. That is what makes an inferred
 * map auditable rather than a drawing you have to take on faith, and it is the
 * reason this is React Flow and not a static diagram.
 */

import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  CircleDot,
  CornerDownRight,
  GitBranch,
  Quote,
  RefreshCw,
  Send,
  Shield,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";

export interface LogicStepData extends Record<string, unknown> {
  label: string;
  detail?: string | null;
  refs?: string[];
  evidence?: { file: string; lines: [number, number]; quote: string } | null;
  confidence?: number | null;
  /** Findings the server already routed to this step. */
  diagnostics?: { level: string; message: string }[];
  aggregated?: boolean;
  terminal?: boolean;
  /** Niveau d'imbrication de contrôle : le corps d'une boucle porte une marque. */
  depth?: number;
  until?: string | null;
}

const KIND_STYLE: Record<
  string,
  { icon: typeof Shield; ring: string; chip: string; labelKey: string }
> = {
  step: {
    icon: CircleDot,
    ring: "border-slate-600",
    chip: "bg-slate-800 text-slate-200",
    labelKey: "logicMap.kind.step",
  },
  decision: {
    icon: GitBranch,
    ring: "border-amber-600",
    chip: "bg-amber-950 text-amber-200",
    labelKey: "logicMap.kind.decision",
  },
  loop: {
    icon: RefreshCw,
    ring: "border-sky-600 border-dashed",
    chip: "bg-sky-950 text-sky-200",
    labelKey: "logicMap.kind.loop",
  },
  tool_call: {
    icon: Wrench,
    ring: "border-sky-600",
    chip: "bg-sky-950 text-sky-200",
    labelKey: "logicMap.kind.toolCall",
  },
  guard: {
    icon: Shield,
    ring: "border-rose-700",
    chip: "bg-rose-950 text-rose-200",
    labelKey: "logicMap.kind.guard",
  },
  policy: {
    icon: CornerDownRight,
    ring: "border-violet-700",
    chip: "bg-violet-950 text-violet-200",
    labelKey: "logicMap.kind.policy",
  },
  emit: {
    icon: Send,
    ring: "border-emerald-700",
    chip: "bg-emerald-950 text-emerald-200",
    labelKey: "logicMap.kind.emit",
  },
};

function StepCard({ kind, data }: { kind: string; data: LogicStepData }) {
  const { t } = useTranslation("agents");
  const [showEvidence, setShowEvidence] = useState(false);
  const style = KIND_STYLE[kind] ?? KIND_STYLE["step"]!;
  const Icon = style.icon;
  const worst = data.diagnostics?.find((d) => d.level === "error") ?? data.diagnostics?.[0];
  // Sous ce seuil la source était trop ambiguë pour qu'on affiche l'étape sans réserve.
  const lowConfidence = typeof data.confidence === "number" && data.confidence < 0.75;

  return (
    <div
      className={`w-[320px] rounded border bg-neutral-950/90 ${style.ring} ${
        data.terminal ? "border-b-4" : ""
      } ${(data.depth ?? 0) > 0 ? "border-l-4 border-l-sky-800" : ""}`}
    >
      <Handle type="target" position={Position.Top} className="!bg-neutral-600" />
      <div className="flex items-start gap-2 px-3 pt-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden />
        <span className={`rounded px-1.5 py-0.5 text-[10px] tracking-wide uppercase ${style.chip}`}>
          {t(style.labelKey)}
        </span>
        {data.aggregated && (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
            {t("logicMap.aggregated")}
          </span>
        )}
        {worst && (
          <AlertTriangle
            className={`ml-auto h-3.5 w-3.5 shrink-0 ${
              worst.level === "error" ? "text-rose-400" : "text-amber-400"
            }`}
            aria-label={worst.message}
          />
        )}
      </div>

      <p className="px-3 pt-1.5 text-sm leading-snug text-neutral-100">{data.label}</p>
      {data.until && (
        <p className="px-3 pt-1 text-xs text-sky-300">
          {t("logicMap.until", { condition: data.until })}
        </p>
      )}
      {data.detail && (
        // Tronqué : le détail situe l'étape, il n'a pas à être lu en entier — et une
        // carte qui grandit sans limite fait exploser la hauteur de la colonne.
        <p className="line-clamp-3 px-3 pt-1 text-xs text-neutral-400">{data.detail}</p>
      )}

      {data.refs && data.refs.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pt-2">
          {data.refs.map((ref) => (
            <code
              key={ref}
              className="rounded bg-neutral-900 px-1 py-0.5 text-[10px] text-neutral-400"
            >
              {ref}
            </code>
          ))}
        </div>
      )}

      {data.evidence && (
        <div className="mt-2 border-t border-neutral-800">
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-neutral-500 hover:text-neutral-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          >
            <Quote className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate font-mono">
              {data.evidence.file.split("/").pop()} · {data.evidence.lines[0]}
              {data.evidence.lines[1] !== data.evidence.lines[0]
                ? `-${data.evidence.lines[1]}`
                : ""}
            </span>
            {lowConfidence && (
              <span className="ml-auto shrink-0 text-amber-500">
                {Math.round((data.confidence ?? 0) * 100)}%
              </span>
            )}
          </button>
          {showEvidence && (
            <blockquote className="mx-3 mb-2 border-l-2 border-amber-700/60 bg-amber-950/20 px-2 py-1.5 text-xs leading-snug text-neutral-300 italic">
              {data.evidence.quote}
            </blockquote>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-neutral-600" />
    </div>
  );
}

/**
 * Cadre d'un domaine, dessiné DERRIÈRE les cartes qu'il contient.
 *
 * Sans lui, une colonne de douze politiques ressemble à douze cartes sans rapport,
 * alors que le domaine est précisément ce qui les relie — et sur un document de
 * règles, ce regroupement est la seule structure qui existe.
 */
export function GroupFrame({ data }: NodeProps) {
  const d = data as { name: string; shape: string; count: number };
  const sequence = d.shape === "sequence";
  return (
    <div
      className={`pointer-events-none h-full w-full rounded-lg border border-dashed ${
        sequence ? "border-sky-900/70 bg-sky-950/10" : "border-violet-900/70 bg-violet-950/10"
      }`}
    >
      <div className="flex items-baseline gap-2 px-3 pt-2">
        <span className="text-[11px] tracking-wide text-neutral-400 uppercase">{d.name}</span>
        <span className="text-[10px] text-neutral-600">{d.count}</span>
      </div>
    </div>
  );
}

export function StepNode({ data }: NodeProps) {
  return <StepCard kind="step" data={data as LogicStepData} />;
}
export function DecisionNode({ data }: NodeProps) {
  return <StepCard kind="decision" data={data as LogicStepData} />;
}
export function LoopNode({ data }: NodeProps) {
  return <StepCard kind="loop" data={data as LogicStepData} />;
}
export function ToolCallNode({ data }: NodeProps) {
  return <StepCard kind="tool_call" data={data as LogicStepData} />;
}
export function GuardNode({ data }: NodeProps) {
  return <StepCard kind="guard" data={data as LogicStepData} />;
}
export function PolicyNode({ data }: NodeProps) {
  return <StepCard kind="policy" data={data as LogicStepData} />;
}
export function EmitNode({ data }: NodeProps) {
  return <StepCard kind="emit" data={data as LogicStepData} />;
}
