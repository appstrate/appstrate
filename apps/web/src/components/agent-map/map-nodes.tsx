// SPDX-License-Identifier: Apache-2.0

/**
 * Node renderers for the agent visual map.
 *
 * One component per server-declared node type. They render `data` verbatim —
 * no fetching, no derivation, no verdict of their own. `data.diagnostics`
 * arrives pre-routed by the server (see `services/agent-map.ts`), so a row
 * badge is a lookup by `item_id`, never a recomputation.
 *
 * The type→component map lives in `agent-map-view.tsx` as a module constant:
 * React Flow requires a stable identity, and keeping this file
 * component-only preserves fast refresh.
 */

import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  Archive,
  ArrowRightToLine,
  Brain,
  Clock,
  Cpu,
  Globe,
  Info,
  Lock,
  Pencil,
  Plug,
  Plus,
  Puzzle,
  Server,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { AgentMapDiagnostic } from "../../hooks/use-agent-map";
import { packageDetailPath } from "../../lib/package-paths";
import { Modal } from "../modal";
import type { MapEditKind } from "./map-edit-dialog";
import type { MapPanelKind } from "./map-panel-dialog";

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

/** Keeps the rendered card in step with the server's height estimate. */
const MAX_LIST_HEIGHT = "max-h-[352px]";

function diagnosticsFor(
  diagnostics: AgentMapDiagnostic[],
  itemId: string | null,
): AgentMapDiagnostic[] {
  return diagnostics.filter((d) => d.item_id === itemId);
}

/** Row-level warning marker. Title carries the server's message verbatim. */
function DiagnosticBadge({ diagnostics }: { diagnostics: AgentMapDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <span
      className="text-warning shrink-0"
      title={diagnostics.map((d) => d.message).join("\n")}
      aria-label={diagnostics[0]!.message}
    >
      <AlertTriangle className="size-3.5" />
    </span>
  );
}

/**
 * A card's entry point for changing what it shows: either edited in place
 * (`onClick`, opening the shared editor widgets in a dialog) or handed off to
 * the page that owns it (`href`, e.g. schedules).
 *
 * `icon` distinguishes the two verbs a header can offer. A card holding a list
 * you extend (skills, integrations, schedules) gets a plus; a card holding ONE
 * thing you change (the model, the prompt, the granted tools) gets a pencil —
 * a plus there promised an addition the dialog does not perform.
 */
type CardAction = { label: string; icon?: "plus" | "edit" } & (
  { onClick: () => void; href?: never } | { href: string; onClick?: never }
);

// `nodrag nopan` stops a press on a control from panning the canvas or starting
// a node drag. It is NOT what makes the control clickable — that requires the
// node to stay `selectable` (see agent-map-view.tsx), without which React Flow
// sets `pointer-events: none` on the whole node.
const ACTION_CLASS = "text-muted-foreground hover:text-foreground nodrag nopan transition-colors";

function CardActionButton({ action }: { action: CardAction }) {
  const Icon = action.icon === "edit" ? Pencil : Plus;
  const shared = {
    title: action.label,
    "aria-label": action.label,
    className: ACTION_CLASS,
  };
  if (action.href !== undefined) {
    return (
      <Link to={action.href} {...shared}>
        <Icon className="size-3.5" />
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onClick} {...shared}>
      <Icon className="size-3.5" />
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
function ConceptButton({ concept }: { concept: string }) {
  const { t } = useTranslation("agents");
  const [open, setOpen] = useState(false);
  const title = t(`map.concept.${concept}.title`);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("map.explain", { concept: title })}
        aria-label={t("map.explain", { concept: title })}
        className={ACTION_CLASS}
      >
        <Info className="size-3.5" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={title}>
        <div className="space-y-3 text-sm leading-relaxed">
          {t(`map.concept.${concept}.body`)
            .split("\n\n")
            .map((paragraph) => (
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
function Card({
  title,
  concept,
  count,
  children,
  targets,
  sources,
  wide,
  action,
  emptyLabel,
  isEmpty,
}: {
  title: string;
  /** i18n key suffix under `map.concept.` for the header's explanation dialog. */
  concept: string;
  count?: number;
  children: React.ReactNode;
  /** Sides edges arrive on. The agent has two: `left` from its triggers, `top` from its input. */
  targets?: HandleSide[];
  /** Sides edges leave from. The agent has two: `right` to its capabilities, `bottom` to its output. */
  sources?: HandleSide[];
  wide?: boolean;
  action?: CardAction | undefined;
  emptyLabel?: string;
  isEmpty?: boolean;
}) {
  return (
    <div
      className={`border-border bg-card rounded-lg border shadow-sm ${wide ? "w-[340px]" : "w-[300px]"}`}
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
      <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
          {title}
        </span>
        <span className="flex items-center gap-2">
          {count !== undefined && (
            <span className="text-muted-foreground text-[11px]">{count}</span>
          )}
          <ConceptButton concept={concept} />
          {action && <CardActionButton action={action} />}
        </span>
      </div>
      <div className={`${MAX_LIST_HEIGHT} overflow-y-auto p-2`}>
        {isEmpty && emptyLabel ? (
          <div className="text-muted-foreground px-2 py-1.5 text-[11px] italic">{emptyLabel}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

/**
 * One list line. With `href` it becomes a link to the resource it describes, so
 * a flagged row is also the way to go fix it — the map is read-only about the
 * agent's definition, not a dead end. Routes are built client-side from the
 * package id: the server has no business knowing the SPA's URLs.
 */
function Row({
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
  const className = `flex items-center gap-2 rounded-md px-2 py-1.5 ${dimmed ? "opacity-50" : ""}`;
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
function SectionButton({
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

// ---------------------------------------------------------------------------
// Item shapes
//
// `data` is polymorphic on the wire (`additionalProperties: true`), so each
// renderer narrows to the shape its own node type emits. The server is the
// single author of these objects — see `services/agent-map.ts`.
// ---------------------------------------------------------------------------

interface ScheduleItem {
  id: string;
  name: string | null;
  cron_expression: string;
  timezone: string | null;
  enabled: boolean;
  next_run_at: string | null;
  version_override: string | null;
}
interface ToolboxItem {
  id: string;
  declared_version: string;
  tools?: string[] | "*";
  scopes?: string[];
  status: string | null;
  connected: boolean | null;
  locked: boolean | null;
  missing_scopes: string[];
  run_blocking: boolean;
}
interface SkillItem {
  id: string;
  declared_version: string | null;
  resolved: boolean;
  name: string | null;
}
interface McpServerItem {
  id: string;
  version: string;
}
interface ModelData {
  agent_model_id: string | null;
  org_default_model_id: string | null;
  resolved_model_id: string | null;
  resolved_model_label: string | null;
  resolved: boolean;
  inherited: boolean;
  proxyId: string | null;
}
interface SystemToolItem {
  id: string;
  always: boolean;
}
interface ContractField {
  name: string;
  title: string | null;
  type: string | null;
  required: boolean;
}
interface ConfigItem extends ContractField {
  /** Effective value for this application, defaults merged in. Null = unset. */
  value: string | null;
}
interface AgentData {
  display_name: string;
  description: string | null;
  prompt: string | null;
  timeout: number | null;
}

function items<T>(data: Record<string, unknown>): T[] {
  return Array.isArray(data.items) ? (data.items as T[]) : [];
}

function diagnostics(data: Record<string, unknown>): AgentMapDiagnostic[] {
  return Array.isArray(data.diagnostics) ? (data.diagnostics as AgentMapDiagnostic[]) : [];
}

/**
 * Builds a card action from a handler the view injected into `data`.
 *
 * `onEdit` opens the manifest editor widgets in a dialog; `onPanel` opens one of
 * the agent's existing panels (schedules, model, memory archive, connections)
 * rather than navigating to its tab — the reader is on the map, and being sent to
 * another tab to flip one switch is the wrong trade.
 *
 * Absent handler ⇒ no action, which is how a system package or a pinned version
 * ends up read-only without any card knowing why.
 */
function cardAction<K extends MapEditKind | MapPanelKind>(
  data: Record<string, unknown>,
  slot: "onEdit" | "onPanel",
  kind: K,
  label: string,
  icon: "plus" | "edit" = "plus",
): { label: string; icon: "plus" | "edit"; onClick: () => void } | undefined {
  const handler = data[slot];
  if (typeof handler !== "function") return undefined;
  return { label, icon, onClick: () => (handler as (k: K) => void)(kind) };
}

// ---------------------------------------------------------------------------
// Node renderers
// ---------------------------------------------------------------------------

export function SchedulesNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<ScheduleItem>(data);
  return (
    <Card
      title={t("map.schedules")}
      concept="schedules"
      count={list.length}
      sources={["right"]}
      isEmpty={list.length === 0}
      emptyLabel={t("map.emptySchedules")}
      // Straight to the create form, agent pre-selected. It used to open a panel
      // that re-listed the schedules this card already shows and offered its own
      // "add" link — two clicks and a duplicated list to reach the one thing a
      // plus can mean.
      action={cardAction(data, "onPanel", "schedules", t("map.addSchedule"))}
    >
      {list.map((item) => (
        <Row
          key={item.id}
          icon={<Clock className="size-3.5" />}
          label={item.name ?? item.cron_expression}
          sublabel={[
            item.cron_expression,
            item.timezone,
            item.version_override ? `→ ${item.version_override}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          dimmed={!item.enabled}
          href={`/schedules/${item.id}`}
          right={
            !item.enabled ? (
              <span className="text-muted-foreground text-[10px]">{t("map.disabled")}</span>
            ) : undefined
          }
        />
      ))}
    </Card>
  );
}

export function AgentNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const d = data as unknown as AgentData & { diagnostics?: AgentMapDiagnostic[] };
  const diags = diagnostics(data);
  const edit = cardAction(data, "onEdit", "prompt", t("map.editPrompt"), "edit");
  const facts = [d.timeout ? `${d.timeout}s` : null].filter(Boolean);

  return (
    <Card
      title={t("map.agent")}
      concept="agent"
      targets={["left", "top"]}
      sources={["right", "bottom"]}
      wide
      action={edit}
    >
      <div className="space-y-2 px-1 py-0.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{d.display_name}</div>
            {d.description && (
              <div className="text-muted-foreground line-clamp-2 text-[11px]">{d.description}</div>
            )}
          </div>
          <DiagnosticBadge diagnostics={diags} />
        </div>
        {facts.length > 0 && (
          <div className="text-muted-foreground flex flex-wrap gap-1 text-[10px]">
            {facts.map((f) => (
              <span key={String(f)} className="bg-muted/50 rounded px-1.5 py-0.5">
                {f}
              </span>
            ))}
          </div>
        )}
        {/* The prompt is the agent. Clicking the excerpt opens the editor, so
            the content itself is the affordance and the header pencil is only a
            second way in — reaching for a small icon to read more of what is
            right there was the wrong ask. */}
        <SectionButton
          onClick={edit?.onClick}
          className="border-border w-full border-t pt-2 text-left"
        >
          <div className="text-muted-foreground mb-1 text-[10px] font-semibold uppercase">
            {t("map.instructions")}
          </div>
          <p className="text-muted-foreground line-clamp-6 text-[11px] whitespace-pre-wrap">
            {d.prompt?.trim() || t("map.noPrompt")}
          </p>
        </SectionButton>
      </div>
    </Card>
  );
}

export function ToolboxNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<ToolboxItem>(data);
  const diags = diagnostics(data);
  const connect = cardAction(data, "onPanel", "connections", t("detail.tabConnections"));
  return (
    <Card
      title={t("map.toolbox")}
      concept="toolbox"
      count={list.length}
      targets={["left"]}
      isEmpty={list.length === 0}
      emptyLabel={t("map.emptyToolbox")}
      action={cardAction(data, "onEdit", "integrations", t("map.addIntegration"))}
    >
      {list.map((item) => {
        const toolLabel =
          item.tools === "*"
            ? t("map.allTools")
            : item.tools
              ? t("map.toolCount", { count: item.tools.length })
              : t("map.noTools");
        return (
          <Row
            key={item.id}
            icon={<Plug className="size-3.5" />}
            label={item.id}
            sublabel={`${item.declared_version} · ${toolLabel}`}
            dimmed={item.connected === false}
            // Connecting is what a flagged row asks for, and that panel exists —
            // so the row opens it rather than navigating to the integration page.
            {...(connect
              ? { onClick: connect.onClick }
              : { href: packageDetailPath("integration", item.id) })}
            right={
              <span className="flex items-center gap-1">
                {item.locked && (
                  <span className="text-muted-foreground" title={t("map.adminLocked")}>
                    <Lock className="size-3" />
                  </span>
                )}
                <DiagnosticBadge diagnostics={diagnosticsFor(diags, item.id)} />
              </span>
            }
          />
        );
      })}
    </Card>
  );
}

export function SkillsNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<SkillItem>(data);
  const diags = diagnostics(data);
  const edit = cardAction(data, "onEdit", "skills", t("map.addSkill"));
  return (
    <Card
      title={t("map.skills")}
      concept="skills"
      count={list.length}
      targets={["left"]}
      isEmpty={list.length === 0}
      emptyLabel={t("map.emptySkills")}
      action={edit}
    >
      {list.map((item) => (
        <Row
          key={item.id}
          icon={<Puzzle className="size-3.5" />}
          label={item.name ?? item.id}
          sublabel={item.declared_version}
          dimmed={!item.resolved}
          // A declared-but-missing skill has no detail page to link to, and
          // leaving the row inert made the one flagged item on the card the only
          // thing you could not act on. It goes to the editor instead.
          {...(item.resolved
            ? { href: packageDetailPath("skill", item.id) }
            : { onClick: edit?.onClick })}
          right={<DiagnosticBadge diagnostics={diagnosticsFor(diags, item.id)} />}
        />
      ))}
    </Card>
  );
}

export function ModelNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const d = data as unknown as ModelData;
  // One model, changed rather than added — a pencil, and the row itself opens
  // the same picker so the content is clickable.
  const choose = cardAction(data, "onPanel", "model", t("map.chooseModel"), "edit");
  return (
    <Card
      title={t("map.model")}
      concept="model"
      // An input card: the model feeds the agent (edge `model->agent`).
      sources={["right"]}
      // Model and proxy are per-application settings rather than manifest
      // fields, so this mounts the configuration tab's own picker in a dialog.
      action={choose}
    >
      <Row
        icon={<Cpu className="size-3.5" />}
        label={d.resolved_model_label ?? t("map.noModel")}
        sublabel={
          d.resolved
            ? d.inherited
              ? t("map.modelInherited")
              : t("map.modelPinned")
            : t("map.noModelHint")
        }
        dimmed={!d.resolved}
        onClick={choose?.onClick}
        right={
          d.resolved ? undefined : (
            <span className="text-warning shrink-0" title={t("map.noModelHint")}>
              <AlertTriangle className="size-3.5" />
            </span>
          )
        }
      />
      {d.proxyId && d.proxyId !== "none" && (
        <Row icon={<Globe className="size-3.5" />} label={d.proxyId} sublabel={t("map.proxy")} />
      )}
    </Card>
  );
}

export function SystemToolsNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<SystemToolItem>(data);
  const browse = cardAction(data, "onPanel", "memory", t("map.openMemory"));
  // A checklist you tick, not a list you append to.
  const grant = cardAction(data, "onEdit", "runtime_tools", t("map.grantSystemTools"), "edit");
  return (
    <Card
      title={t("map.systemTools")}
      concept="systemTools"
      count={list.length}
      targets={["left"]}
      isEmpty={list.length === 0}
      emptyLabel={t("map.emptySystemTools")}
      // These are granted in the manifest (`runtime_tools`), so the affordance
      // opens the same checklist the editor uses.
      action={grant}
    >
      {list.map((item) => (
        <Row
          key={item.id}
          icon={<Brain className="size-3.5" />}
          label={t(`map.systemTool.${item.id}`, { defaultValue: item.id })}
          sublabel={item.always ? t("map.toolAlways") : t("map.toolGranted")}
          // An always-on tool is not in the checklist, so sending its row there
          // would open a dialog that cannot show it.
          onClick={item.always ? undefined : grant?.onClick}
        />
      ))}
      {/* What the agent actually remembers is data, not definition — so it is a
          row that opens the archive panel, not part of the capability list. */}
      {browse && (
        <Row
          icon={<Archive className="size-3.5" />}
          label={t("map.openMemory")}
          onClick={browse.onClick}
        />
      )}
    </Card>
  );
}

/**
 * The two contract cards: what a caller must hand the agent, what the agent
 * hands back. Same rendering, opposite ends of the canvas — so one component,
 * parameterised by side.
 *
 * Deliberately NOT merged into the system tools card. The `output` runtime tool
 * is a mechanism the agent is granted; `output.schema` is the shape its result
 * must take. An agent can declare the schema without the tool (and the save gate
 * will refuse it), which is exactly the mismatch a reader needs to see.
 */
function ContractNode({ data, side }: { data: Record<string, unknown>; side: "input" | "output" }) {
  const { t } = useTranslation("agents");
  const list = items<ContractField>(data);
  // A schema is one shape you reshape, not a list you append to — hence the
  // pencil, and rows that open the same field editor the package editor uses.
  const edit = cardAction(
    data,
    "onEdit",
    side,
    side === "input" ? t("map.editInput") : t("map.editOutput"),
    "edit",
  );
  return (
    <Card
      title={side === "input" ? t("map.input") : t("map.output")}
      concept={side}
      count={list.length}
      {...(side === "input" ? { sources: ["bottom" as const] } : { targets: ["top" as const] })}
      isEmpty={list.length === 0}
      emptyLabel={side === "input" ? t("map.emptyInput") : t("map.emptyOutput")}
      action={edit}
    >
      {list.map((field) => (
        <Row
          key={field.name}
          icon={
            side === "input" ? (
              <ArrowRightToLine className="size-3.5" />
            ) : (
              <Sparkles className="size-3.5" />
            )
          }
          label={field.title ?? field.name}
          sublabel={[field.type, field.required ? t("map.fieldRequired") : null]
            .filter(Boolean)
            .join(" · ")}
          onClick={edit?.onClick}
        />
      ))}
    </Card>
  );
}

/**
 * Per-installation settings: the `config` schema, each row carrying the value
 * this application actually runs with.
 *
 * Not on the agent's vertical axis, and deliberately so. `input` is handed over
 * at every run, `config` is set once for this installation — same AFPS shape,
 * different lifetime. Its neighbour is the model, the other per-application
 * setting, not the contract.
 */
export function ConfigNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<ConfigItem>(data);
  const diags = diagnostics(data);
  const edit = cardAction(data, "onPanel", "config", t("map.editConfig"), "edit");
  return (
    <Card
      title={t("map.config")}
      concept="config"
      count={list.length}
      sources={["right"]}
      isEmpty={list.length === 0}
      emptyLabel={t("map.emptyConfig")}
      action={edit}
    >
      {list.map((field) => (
        <Row
          key={field.name}
          icon={<SlidersHorizontal className="size-3.5" />}
          label={field.title ?? field.name}
          // The value is the point of this card; the type only matters when
          // there is no value to show yet.
          sublabel={field.value ?? t("map.configUnset")}
          dimmed={field.value === null}
          onClick={edit?.onClick}
          right={<DiagnosticBadge diagnostics={diagnosticsFor(diags, field.name)} />}
        />
      ))}
    </Card>
  );
}

export function InputNode({ data }: NodeProps) {
  return <ContractNode data={data} side="input" />;
}

export function OutputNode({ data }: NodeProps) {
  return <ContractNode data={data} side="output" />;
}

export function McpServersNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<McpServerItem>(data);
  const diags = diagnostics(data);
  return (
    <Card
      title={t("map.mcpServers")}
      concept="mcpServers"
      count={list.length}
      targets={["left"]}
      isEmpty={list.length === 0}
      emptyLabel={t("map.emptyMcpServers")}
    >
      {list.map((item) => (
        <Row
          key={item.id}
          icon={<Server className="size-3.5" />}
          label={item.id}
          sublabel={item.version}
          href={packageDetailPath("mcp-server", item.id)}
          right={<DiagnosticBadge diagnostics={diagnosticsFor(diags, item.id)} />}
        />
      ))}
    </Card>
  );
}
