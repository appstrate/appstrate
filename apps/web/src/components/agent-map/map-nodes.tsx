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

import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  Archive,
  Brain,
  Clock,
  Cpu,
  Globe,
  Lock,
  Plug,
  Plus,
  Puzzle,
  Server,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { AgentMapDiagnostic } from "../../hooks/use-agent-map";
import { packageDetailPath } from "../../lib/package-paths";
import type { MapEditKind } from "./map-edit-dialog";
import type { MapPanelKind } from "./map-panel-dialog";

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

/** Keeps the rendered card in step with the server's height estimate. */
const MAX_LIST_HEIGHT = "max-h-[352px]";

function diagnosticsFor(
  diagnostics: AgentMapDiagnostic[] | undefined,
  itemId: string | null,
): AgentMapDiagnostic[] {
  if (!diagnostics) return [];
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
 */
type CardAction = { label: string; onClick: () => void } | { label: string; href: string };

// `nodrag nopan` stops a press on a control from panning the canvas or starting
// a node drag. It is NOT what makes the control clickable — that requires the
// node to stay `selectable` (see agent-map-view.tsx), without which React Flow
// sets `pointer-events: none` on the whole node.
const ACTION_CLASS = "text-muted-foreground hover:text-foreground nodrag nopan transition-colors";

function CardActionButton({ action }: { action: CardAction }) {
  if ("href" in action) {
    return (
      <Link
        to={action.href}
        title={action.label}
        aria-label={action.label}
        className={ACTION_CLASS}
      >
        <Plus className="size-3.5" />
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={action.onClick}
      title={action.label}
      aria-label={action.label}
      className={ACTION_CLASS}
    >
      <Plus className="size-3.5" />
    </button>
  );
}

/**
 * Card shell. Every card is always drawn, even empty, so the set of cards reads
 * as the inventory of what an agent manifest can hold and an empty one says
 * "you'd add it here".
 */
function Card({
  title,
  count,
  children,
  hasIncoming,
  hasOutgoing,
  wide,
  action,
  emptyLabel,
  isEmpty,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  hasIncoming?: boolean;
  hasOutgoing?: boolean;
  wide?: boolean;
  action?: CardAction | undefined;
  emptyLabel?: string;
  isEmpty?: boolean;
}) {
  return (
    <div
      className={`border-border bg-card rounded-lg border shadow-sm ${wide ? "w-[340px]" : "w-[300px]"}`}
    >
      {hasIncoming && <Handle type="target" position={Position.Left} className="!bg-border" />}
      {hasOutgoing && <Handle type="source" position={Position.Right} className="!bg-border" />}
      <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
          {title}
        </span>
        <span className="flex items-center gap-2">
          {count !== undefined && (
            <span className="text-muted-foreground text-[11px]">{count}</span>
          )}
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
interface MemoryItem {
  id: string;
  declared: boolean;
  always: boolean;
}
interface AgentData {
  display_name: string;
  description: string | null;
  prompt: string | null;
  timeout: number | null;
  runtime_tools: string[];
  modelId: string | null;
  has_input_schema: boolean;
  has_output_schema: boolean;
}

function items<T>(data: Record<string, unknown>): T[] {
  return Array.isArray(data.items) ? (data.items as T[]) : [];
}

function diagnostics(data: Record<string, unknown>): AgentMapDiagnostic[] {
  return Array.isArray(data.diagnostics) ? (data.diagnostics as AgentMapDiagnostic[]) : [];
}

/**
 * In-place edit action, injected by the view alongside the diagnostics. Absent
 * for a system package (its definition ships with the platform and the API
 * refuses the write), so the card offers nothing it cannot deliver.
 */
function editAction(
  data: Record<string, unknown>,
  kind: MapEditKind,
  label: string,
): CardAction | undefined {
  const onEdit = data.onEdit;
  if (typeof onEdit !== "function") return undefined;
  return { label, onClick: () => (onEdit as (k: MapEditKind) => void)(kind) };
}

/**
 * Opens one of the agent's existing panels (schedules, model, memory archive,
 * connections) in a dialog rather than navigating to its tab: the reader is on
 * the map, and being sent to another tab to flip one switch — then having to come
 * back — is the wrong trade. Injected by the view, like `onEdit`.
 */
function panelAction(
  data: Record<string, unknown>,
  kind: MapPanelKind,
  label: string,
): CardAction | undefined {
  const onPanel = data.onPanel;
  if (typeof onPanel !== "function") return undefined;
  return { label, onClick: () => (onPanel as (k: MapPanelKind) => void)(kind) };
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
      count={list.length}
      hasOutgoing
      isEmpty={list.length === 0}
      emptyLabel={t("map.emptySchedules")}
      // The Schedules panel opens right here rather than throwing the reader
      // onto another tab and back.
      action={panelAction(data, "schedules", t("map.addSchedule"))}
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
  const facts = [
    d.modelId,
    d.timeout ? `${d.timeout}s` : null,
    d.has_input_schema ? t("map.hasInput") : null,
    d.has_output_schema ? t("map.hasOutput") : null,
    d.runtime_tools.length > 0 ? d.runtime_tools.join(", ") : null,
  ].filter(Boolean);

  return (
    <Card
      title={t("map.agent")}
      hasIncoming
      hasOutgoing
      wide
      action={editAction(data, "prompt", t("map.editPrompt"))}
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
        <div className="border-border border-t pt-2">
          <div className="text-muted-foreground mb-1 text-[10px] font-semibold uppercase">
            {t("map.instructions")}
          </div>
          <p className="text-muted-foreground line-clamp-6 text-[11px] whitespace-pre-wrap">
            {d.prompt?.trim() || t("map.noPrompt")}
          </p>
        </div>
      </div>
    </Card>
  );
}

export function ToolboxNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<ToolboxItem>(data);
  const diags = diagnostics(data);
  return (
    <Card
      title={t("map.toolbox")}
      count={list.length}
      hasIncoming
      isEmpty={list.length === 0}
      emptyLabel={t("map.emptyToolbox")}
      action={editAction(data, "integrations", t("map.addIntegration"))}
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
            href={packageDetailPath("integration", item.id)}
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
  return (
    <Card
      title={t("map.skills")}
      count={list.length}
      hasIncoming
      isEmpty={list.length === 0}
      emptyLabel={t("map.emptySkills")}
      action={editAction(data, "skills", t("map.addSkill"))}
    >
      {list.map((item) => (
        <Row
          key={item.id}
          icon={<Puzzle className="size-3.5" />}
          label={item.name ?? item.id}
          sublabel={item.declared_version}
          dimmed={!item.resolved}
          // A declared-but-missing skill has no detail page to link to.
          {...(item.resolved ? { href: packageDetailPath("skill", item.id) } : {})}
          right={<DiagnosticBadge diagnostics={diagnosticsFor(diags, item.id)} />}
        />
      ))}
    </Card>
  );
}

export function ModelNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const d = data as unknown as ModelData;
  return (
    <Card
      title={t("map.model")}
      // An input card: the model feeds the agent (edge `model->agent`).
      hasOutgoing
      // Model and proxy are per-application settings rather than manifest
      // fields, so this mounts the configuration tab's own picker in a dialog.
      {...(panelAction(data, "model", t("map.chooseModel"))
        ? { action: panelAction(data, "model", t("map.chooseModel"))! }
        : {})}
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

export function MemoryNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<MemoryItem>(data);
  const browse = panelAction(data, "memory", t("map.openMemory"));
  return (
    <Card
      title={t("map.memory")}
      hasIncoming
      // `pin`/`note` are platform runtime tools granted in the manifest, so the
      // affordance GRANTS them (system-tools checklist) instead of merely linking
      // to the archive. Browsing what is remembered stays a row action below.
      {...(editAction(data, "runtime_tools", t("map.grantMemory"))
        ? { action: editAction(data, "runtime_tools", t("map.grantMemory"))! }
        : {})}
    >
      {list.map((item) => (
        <Row
          key={item.id}
          icon={<Brain className="size-3.5" />}
          label={t(`map.memoryTool.${item.id}`, { defaultValue: item.id })}
          sublabel={
            item.always
              ? t("map.memoryAlways")
              : item.declared
                ? t("map.memoryGranted")
                : t("map.memoryNotGranted")
          }
          dimmed={!item.declared}
        />
      ))}
      {/* What the agent actually remembers is data, not definition — so it is a
          row that opens the archive panel, not part of the capability list. */}
      {browse && "onClick" in browse && (
        <Row
          icon={<Archive className="size-3.5" />}
          label={t("map.openMemory")}
          onClick={browse.onClick}
        />
      )}
    </Card>
  );
}

export function McpServersNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<McpServerItem>(data);
  const diags = diagnostics(data);
  return (
    <Card
      title={t("map.mcpServers")}
      count={list.length}
      hasIncoming
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
