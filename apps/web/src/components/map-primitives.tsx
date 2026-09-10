// SPDX-License-Identifier: Apache-2.0

/** Shared visual map primitives. Agent and integration maps use the same renderers. */
import { Children, useLayoutEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, ChevronRight, Info, Pencil, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Modal } from "./modal";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";

const PREVIEW_ROW_COUNT = 3;

export type CardAction = { label: string; icon?: "plus" | "edit" | "open" } & (
  { onClick: () => void; href?: never } | { href: string; onClick?: never }
);

// `nodrag nopan` stops a press on a control from panning the canvas or starting
// a node drag. It is NOT what makes the control clickable — that requires the
// node to stay `selectable` (see agent-map-view.tsx), without which React Flow
// sets `pointer-events: none` on the whole node.
const ACTION_CLASS = "text-muted-foreground hover:text-foreground nodrag nopan transition-colors";

function CardActionButton({ action }: { action: CardAction }) {
  const Icon = action.icon === "edit" ? Pencil : action.icon === "open" ? ArrowUpRight : Plus;
  const shared = {
    title: action.label,
    "aria-label": action.label,
    className:
      "text-foreground/80 hover:text-foreground focus-visible:ring-primary nodrag nopan inline-flex size-8 shrink-0 items-center justify-center rounded-md p-0 transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none [&>svg]:shrink-0",
  };
  if (action.href !== undefined) {
    return (
      <Link to={action.href} {...shared}>
        <Icon className="size-5" />
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onClick} {...shared}>
      <Icon className="size-5" />
    </button>
  );
}

/**
 * "What is this card even about?" — one dialog per card, explaining the
 * Appstrate concept it projects rather than the widget.
 *
 * The map is most useful to someone still building a model of the platform, and
 * that reader has no other place to ask what a skill is, or why an integration
 * is not the same thing as an MCP server. Text lives in i18n under
 * `map.concept.<id>` so both languages carry it; paragraphs are split on blank
 * lines so an explanation can breathe.
 */
function ConceptTitle({
  concept,
  children,
}: {
  concept: string | { title: string; body: string };
  children: React.ReactNode;
}) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const [open, setOpen] = useState(false);
  const title =
    typeof concept === "string" ? t(`agent-map:concept.${concept}.title`) : concept.title;
  const body = typeof concept === "string" ? t(`agent-map:concept.${concept}.body`) : concept.body;
  const explanation = t("agent-map:explain", { concept: title });
  return (
    <>
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label={explanation}
              className={`${ACTION_CLASS} block min-w-0 flex-1 truncate text-left text-[10px] font-semibold tracking-wide whitespace-nowrap uppercase`}
            >
              {children}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{explanation}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Modal open={open} onClose={() => setOpen(false)} title={title}>
        <div className="space-y-3 text-sm leading-relaxed">
          {body.split("\n\n").map((paragraph) => (
            <p key={paragraph.slice(0, 24)}>{paragraph}</p>
          ))}
        </div>
      </Modal>
    </>
  );
}

const HANDLE_POSITION = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
} as const;

/** Which sides a card is wired on. Ids match the server's `*_handle` values. */
type HandleSide = keyof typeof HANDLE_POSITION;

/**
 * Card shell. Every card is always drawn, even empty, so the set of cards reads
 * as the inventory of what an agent manifest can hold and an empty one says
 * "you'd add it here".
 */
export function MapCard({
  icon,
  title,
  concept,
  count,
  children,
  targets,
  sources,
  wide,
  horizontal,
  relationId,
  relationActive,
  onRelationActive,
  action,
  emptyLabel,
  emptyAction,
}: {
  icon: React.ReactNode;
  title: string;
  /** i18n key suffix under `map.concept.` for the header's explanation dialog. */
  concept?: string | { title: string; body: string };
  /** Rows listed. Omitted by the prose cards (agent, model), which are never empty. */
  count?: number;
  children: React.ReactNode;
  /** Sides edges arrive on. The agent has two: `left` from its triggers, `top` from its input. */
  targets?: HandleSide[];
  /** Sides edges leave from. The agent has two: `right` to its capabilities, `bottom` to its output. */
  sources?: HandleSide[];
  wide?: boolean;
  /** A transverse band used only by memory beneath the three main zones. */
  horizontal?: boolean;
  relationId?: string;
  relationActive?: boolean;
  onRelationActive?: ((id: string | null) => void) | undefined;
  action?: CardAction | undefined;
  emptyLabel?: string;
  emptyAction?: { label: string; onClick: () => void } | undefined;
}) {
  const { t } = useTranslation(["agent-map"]);
  const [listOpen, setListOpen] = useState(false);
  const rows = Children.toArray(children);
  const previewLimit = horizontal ? 4 : PREVIEW_ROW_COUNT;
  const hasOverflow = count !== undefined && rows.length > previewLimit;
  const preview = hasOverflow ? rows.slice(0, previewLimit) : rows;
  const resolvedEmptyAction =
    emptyAction ??
    (count === 0 && action && "onClick" in action
      ? { label: action.label, onClick: action.onClick }
      : undefined);

  return (
    <>
      <div
        className={`agent-map-card border-border bg-card flex flex-col rounded-lg border shadow-sm transition-shadow ${relationActive ? "ring-primary ring-2 ring-offset-2" : ""} ${horizontal ? "w-[1130px]" : wide ? "h-[248px] w-[280px]" : "h-[206px] w-[210px]"}`}
        onMouseEnter={() => relationId && onRelationActive?.(relationId)}
        onMouseLeave={(event) => {
          if (relationId && !event.currentTarget.contains(document.activeElement)) {
            onRelationActive?.(null);
          }
        }}
        onFocusCapture={() => relationId && onRelationActive?.(relationId)}
        onBlurCapture={(event) => {
          if (relationId && !event.currentTarget.contains(event.relatedTarget)) {
            onRelationActive?.(null);
          }
        }}
      >
        {/* Each handle carries its side as its id: a node with more than one of a
          kind is ambiguous otherwise, and React Flow silently drops the edge. */}
        {(targets ?? []).map((side) => (
          <Handle
            key={`t-${side}`}
            id={side}
            type="target"
            position={HANDLE_POSITION[side]}
            className="!bg-border"
          />
        ))}
        {(sources ?? []).map((side) => (
          <Handle
            key={`s-${side}`}
            id={side}
            type="source"
            position={HANDLE_POSITION[side]}
            className="!bg-border"
          />
        ))}
        <div className="border-border flex min-h-9 items-center justify-between gap-2 border-b py-1 pr-1.5 pl-3">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="text-muted-foreground shrink-0 [&>svg]:size-3.5">{icon}</span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {concept ? (
                <ConceptTitle concept={concept}>{title}</ConceptTitle>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[10px] font-semibold tracking-wide uppercase">
                  {title}
                </span>
              )}
              {count !== undefined && (
                <span className="bg-muted text-muted-foreground inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1.5 text-[10px] font-medium tabular-nums">
                  {count}
                </span>
              )}
            </span>
          </span>
          {action && !(count === 0 && resolvedEmptyAction) && <CardActionButton action={action} />}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden p-2">
          {/* Emptiness is `count`, not a second prop saying the same thing: every
            list card passed `count={list.length}` AND `isEmpty={length === 0}`. */}
          {count === 0 && resolvedEmptyAction ? (
            <button
              type="button"
              onClick={resolvedEmptyAction.onClick}
              className="text-foreground hover:bg-muted/60 nodrag nopan flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-[11px] font-medium transition-colors"
            >
              {resolvedEmptyAction.label}
              <ChevronRight className="text-muted-foreground size-3.5" />
            </button>
          ) : count === 0 && emptyLabel ? (
            <div className="text-muted-foreground px-2 py-1.5 text-[11px] italic">{emptyLabel}</div>
          ) : (
            <div className={horizontal ? "grid grid-cols-4 gap-1" : undefined}>
              {count !== undefined && !horizontal
                ? Children.map(preview, (row) => (
                    <div className="[&:not(:last-child)]:after:bg-border/50 relative [&:not(:last-child)]:after:absolute [&:not(:last-child)]:after:right-1 [&:not(:last-child)]:after:bottom-0 [&:not(:last-child)]:after:left-1 [&:not(:last-child)]:after:h-px [&:not(:last-child)]:after:content-['']">
                      {row}
                    </div>
                  ))
                : preview}
            </div>
          )}
        </div>
        {hasOverflow && (
          <button
            type="button"
            onClick={() => setListOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground nodrag nopan flex w-full items-center justify-between border-t px-3 py-2 text-left text-[11px] font-medium transition-colors"
          >
            {t("agent-map:viewMore", { count: rows.length - previewLimit })}
            <ChevronRight className="size-3.5" />
          </button>
        )}
      </div>
      <Modal open={listOpen} onClose={() => setListOpen(false)} title={title}>
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">{rows}</div>
      </Modal>
    </>
  );
}

/**
 * One list line. With `href` it becomes a link to the resource it describes, so
 * a flagged row is also the way to go fix it — the map is read-only about the
 * agent's definition, not a dead end. Routes are built client-side from the
 * package id: the server has no business knowing the SPA's URLs.
 */
export function MapRow({
  icon,
  label,
  sublabel,
  right,
  dimmed,
  href,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  sublabel?: string | null;
  right?: React.ReactNode;
  dimmed?: boolean;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
}) {
  const body = (
    <>
      {icon && <span className="text-muted-foreground shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{label}</div>
        {sublabel && <div className="text-muted-foreground truncate text-[11px]">{sublabel}</div>}
      </div>
      {right}
    </>
  );
  const className = `flex items-center gap-2 rounded-md px-2 py-1 ${dimmed ? "opacity-50" : ""}`;
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${className} hover:bg-muted/60 nodrag nopan w-full text-left transition-colors`}
      >
        {body}
      </button>
    );
  }
  if (!href) return <div className={className}>{body}</div>;
  return (
    // `nodrag nopan`: see ACTION_CLASS.
    <Link to={href} className={`${className} hover:bg-muted/60 nodrag nopan transition-colors`}>
      {body}
    </Link>
  );
}

/**
 * A block of card content that is itself the way to edit what it shows.
 *
 * Degrades to a plain `div` when no handler is supplied — a read-only map (system
 * package, pinned version) must not offer a button that does nothing.
 */
export function MapSectionButton({
  onClick,
  className,
  children,
}: {
  onClick?: (() => void) | undefined;
  className: string;
  children: React.ReactNode;
}) {
  if (!onClick) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${className} hover:bg-muted/40 nodrag nopan rounded-md transition-colors`}
    >
      {children}
    </button>
  );
}

export function OverflowFadeText({ children }: { children: string }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const measure = () => setTruncated(text.scrollHeight > text.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div className="relative w-full overflow-hidden">
      <p
        ref={textRef}
        className="text-muted-foreground line-clamp-4 text-[11px] whitespace-pre-wrap"
      >
        {children}
      </p>
      {truncated && (
        <span
          aria-hidden="true"
          className="from-card pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t to-transparent"
        />
      )}
    </div>
  );
}

export function BoundaryNode({ data }: NodeProps) {
  const boundary = data as { label: string; description: string; tooltip?: string };
  const handleClass = "!size-1 !border-0 !bg-transparent";
  return (
    <div className="border-border bg-muted size-full rounded-xl border shadow-sm">
      <Handle id="s-bottom" type="source" position={Position.Bottom} className={handleClass} />
      <Handle id="s-left" type="source" position={Position.Left} className={handleClass} />
      <Handle id="s-right" type="source" position={Position.Right} className={handleClass} />
      <Handle
        id="s-top-left"
        type="source"
        position={Position.Top}
        style={{ left: "42%" }}
        className={handleClass}
      />
      <Handle
        id="s-top-right"
        type="source"
        position={Position.Top}
        style={{ left: "58%" }}
        className={handleClass}
      />
      <Handle id="t-top" type="target" position={Position.Top} className={handleClass} />
      <Handle id="t-left" type="target" position={Position.Left} className={handleClass} />
      <Handle id="t-right" type="target" position={Position.Right} className={handleClass} />
      <Handle
        id="t-bottom-left"
        type="target"
        position={Position.Bottom}
        style={{ left: "42%" }}
        className={handleClass}
      />
      <Handle
        id="t-bottom-right"
        type="target"
        position={Position.Bottom}
        style={{ left: "58%" }}
        className={handleClass}
      />
      <div className="border-border border-b px-5 py-3.5">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[11px] font-semibold tracking-wide uppercase">{boundary.label}</h3>
          {boundary.tooltip && (
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={boundary.tooltip}
                    className={`${ACTION_CLASS} nodrag nopan`}
                  >
                    <Info className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{boundary.tooltip}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 text-[10px] leading-relaxed">
          {boundary.description}
        </p>
      </div>
    </div>
  );
}
