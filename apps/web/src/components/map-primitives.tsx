// SPDX-License-Identifier: Apache-2.0

/** Visual map primitives: the cards, rows and boundaries of an integration's structure map. */
import { Children } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, ChevronRight, Pencil, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useModalParam } from "../hooks/use-modal-param";
import { Modal } from "./modal";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";

const PREVIEW_ROW_COUNT = 3;

type CardAction = { label: string; icon?: "plus" | "edit" | "open" } & (
  { onClick: () => void; href?: never } | { href: string; onClick?: never }
);

// `nodrag nopan` stops a press on a control from panning the canvas or starting
// a node drag. It is NOT what makes the control clickable — that requires the
// node to stay `selectable`, without which React Flow
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
 * that reader has no other place to ask what a concept means. Paragraphs are
 * split on blank lines so an explanation can breathe.
 */
function ConceptTitle({
  concept,
  cardKey,
  children,
}: {
  concept: { title: string; body: string };
  /** The card's stable key: the explanation opens at `?mapConcept=<cardKey>`. */
  cardKey: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation(["common"]);
  const param = useModalParam("mapConcept");
  const { title, body } = concept;
  const explanation = t("common:map.explain", { concept: title });
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => param.open(cardKey)}
            aria-label={explanation}
            className={`${ACTION_CLASS} block min-w-0 flex-1 truncate text-left text-[10px] font-semibold tracking-wide whitespace-nowrap uppercase`}
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{explanation}</TooltipContent>
      </Tooltip>
      <Modal open={param.value === cardKey} onClose={param.close} title={title}>
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
 * as the inventory of what the package can hold and an empty one says "you'd
 * add it here".
 */
export function MapCard({
  icon,
  title,
  concept,
  count,
  children,
  targets,
  sources,
  relationId,
  onRelationActive,
  action,
  emptyLabel,
}: {
  icon: React.ReactNode;
  title: string;
  /** The header's explanation dialog. */
  concept?: { title: string; body: string };
  /** Rows listed. Omitted by a card that is never empty. */
  count?: number;
  children: React.ReactNode;
  /** Sides edges arrive on. */
  targets?: HandleSide[];
  /** Sides edges leave from. */
  sources?: HandleSide[];
  relationId?: string;
  onRelationActive?: ((id: string | null) => void) | undefined;
  action?: CardAction | undefined;
  emptyLabel?: string;
}) {
  const { t } = useTranslation(["common"]);
  // A card is named in the URL by what it already has that is stable: its relation
  // id (the map gives one to the cards that have rows). Never its position. The
  // explanation and the full list open at `?mapConcept=` and `?mapCardList=`.
  const cardKey = relationId;
  const listParam = useModalParam("mapCardList");
  const rows = Children.toArray(children);
  const previewLimit = PREVIEW_ROW_COUNT;
  const hasOverflow = cardKey !== undefined && count !== undefined && rows.length > previewLimit;
  const preview = hasOverflow ? rows.slice(0, previewLimit) : rows;
  const resolvedEmptyAction =
    count === 0 && action && "onClick" in action
      ? { label: action.label, onClick: action.onClick }
      : undefined;

  return (
    <>
      <div
        className="map-card border-border bg-card flex h-[206px] w-[210px] flex-col rounded-lg border shadow-sm transition-shadow"
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
              {concept && cardKey ? (
                <ConceptTitle concept={concept} cardKey={cardKey}>
                  {title}
                </ConceptTitle>
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
            <div>
              {count !== undefined
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
            onClick={() => listParam.open(cardKey)}
            className="border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground nodrag nopan flex w-full items-center justify-between border-t px-3 py-2 text-left text-[11px] font-medium transition-colors"
          >
            {t("common:map.viewMore", { count: rows.length - previewLimit })}
            <ChevronRight className="size-3.5" />
          </button>
        )}
      </div>
      <Modal
        open={cardKey !== undefined && listParam.value === cardKey}
        onClose={listParam.close}
        title={title}
      >
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">{rows}</div>
      </Modal>
    </>
  );
}

/**
 * One list line. With `href` it becomes a link to the resource it describes, so
 * a flagged row is also the way to go fix it: the map is read-only, not a dead
 * end. Routes are built client-side from the package id: the server has no
 * business knowing the SPA's URLs.
 */
export function MapRow({
  label,
  sublabel,
  right,
  href,
  onClick,
}: {
  label: string;
  sublabel?: string | null;
  right?: React.ReactNode;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
}) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{label}</div>
        {sublabel && <div className="text-muted-foreground truncate text-[11px]">{sublabel}</div>}
      </div>
      {right}
    </>
  );
  const className = "flex items-center gap-2 rounded-md px-2 py-1";
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

export function BoundaryNode({ data }: NodeProps) {
  const boundary = data as { label: string; description: string };
  const handleClass = "!size-1 !border-0 !bg-transparent";
  return (
    <div className="border-border bg-muted size-full rounded-xl border shadow-sm">
      <Handle id="s-bottom" type="source" position={Position.Bottom} className={handleClass} />
      <Handle id="s-right" type="source" position={Position.Right} className={handleClass} />
      <Handle id="t-top" type="target" position={Position.Top} className={handleClass} />
      <Handle id="t-left" type="target" position={Position.Left} className={handleClass} />
      <div className="border-border border-b px-5 py-3.5">
        <h3 className="text-[11px] font-semibold tracking-wide uppercase">{boundary.label}</h3>
        <p className="text-muted-foreground mt-0.5 text-[10px] leading-relaxed">
          {boundary.description}
        </p>
      </div>
    </div>
  );
}
