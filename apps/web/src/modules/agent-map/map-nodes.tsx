// SPDX-License-Identifier: Apache-2.0

import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  ArrowRightToLine,
  Bot,
  CalendarClock,
  Cpu,
  Database,
  ExternalLink,
  FileOutput,
  Globe,
  Plug,
  Puzzle,
  Server,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { AgentMapIcon } from "./agent-map-view";

const ICONS = {
  agent: Bot,
  connection: Plug,
  input: ArrowRightToLine,
  integration: Plug,
  mcp: Server,
  memory: Database,
  model: Cpu,
  output: FileOutput,
  proxy: Globe,
  schedule: CalendarClock,
  skill: Puzzle,
  tools: Wrench,
  values: SlidersHorizontal,
} satisfies Record<AgentMapIcon, typeof Bot>;

const HANDLE_CLASS = "!size-1 !border-0 !bg-transparent";

function MapHandles() {
  return (
    <>
      <Handle id="top" type="target" position={Position.Top} className={HANDLE_CLASS} />
      <Handle id="left" type="target" position={Position.Left} className={HANDLE_CLASS} />
      <Handle
        id="left-upper"
        type="target"
        position={Position.Left}
        className={HANDLE_CLASS}
        style={{ top: "30%" }}
      />
      <Handle
        id="left-lower"
        type="target"
        position={Position.Left}
        className={HANDLE_CLASS}
        style={{ top: "70%" }}
      />
      <Handle id="bottom" type="source" position={Position.Bottom} className={HANDLE_CLASS} />
      <Handle id="right" type="source" position={Position.Right} className={HANDLE_CLASS} />
      {["20%", "40%", "60%", "80%"].map((top, index) => (
        <Handle
          key={top}
          id={`right-${index + 1}`}
          type="source"
          position={Position.Right}
          className={HANDLE_CLASS}
          style={{ top }}
        />
      ))}
    </>
  );
}

export function AgentMapBoundaryNode({ data }: NodeProps) {
  const boundary = data as { label: string; description: string };
  return (
    <div className="bg-muted/20 size-full rounded-xl border border-dashed p-4">
      <h3 className="text-[11px] font-semibold tracking-wide uppercase">{boundary.label}</h3>
      <p className="text-muted-foreground mt-0.5 max-w-[32rem] text-[10px]">
        {boundary.description}
      </p>
    </div>
  );
}

export function AgentMapCardNode({ data }: NodeProps) {
  const card = data as {
    title: string;
    value: string;
    description?: string;
    icon: AgentMapIcon;
    href?: string;
    onActivate?: () => void;
    warning?: string;
    actionLabel: string;
    wide?: boolean;
  };
  const Icon = ICONS[card.icon];

  return (
    <div
      className={`bg-card rounded-lg border shadow-sm ${card.warning ? "border-warning/60" : "border-border"} ${card.wide ? "w-[390px]" : "w-[280px]"}`}
    >
      <MapHandles />
      <div className="flex items-start gap-3 p-3">
        <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground text-[10px] font-semibold tracking-wide uppercase">
            {card.title}
          </p>
          <p className="mt-0.5 truncate text-xs font-semibold">{card.value}</p>
          {card.description && (
            <p className="text-muted-foreground mt-1 line-clamp-2 text-[10px] leading-relaxed">
              {card.description}
            </p>
          )}
          {card.warning && (
            <p className="text-warning mt-1 flex items-start gap-1 text-[10px] leading-relaxed">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>{card.warning}</span>
            </p>
          )}
        </div>
        {card.onActivate ? (
          <button
            type="button"
            onClick={card.onActivate}
            className="text-muted-foreground hover:text-foreground nodrag nopan rounded p-1 transition-colors"
            aria-label={`${card.actionLabel}: ${card.title}`}
            title={`${card.actionLabel}: ${card.title}`}
          >
            <ExternalLink className="size-3.5" />
          </button>
        ) : card.href ? (
          <Link
            to={card.href}
            className="text-muted-foreground hover:text-foreground nodrag nopan rounded p-1 transition-colors"
            aria-label={`${card.actionLabel}: ${card.title}`}
            title={`${card.actionLabel}: ${card.title}`}
          >
            <ExternalLink className="size-3.5" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
