// SPDX-License-Identifier: Apache-2.0

/**
 * Node renderers for the agent visual map.
 *
 * One component per server-declared node type. They render `data` verbatim —
 * no fetching, no derivation, no verdict of their own. `data.diagnostics`
 * is the canonical Agent diagnostic interface projected onto the visual node
 * by `agent-map-view.tsx`; a row badge is only a lookup by `target.item`.
 *
 * The type→component map lives in `agent-map-view.tsx` as a module constant:
 * React Flow requires a stable identity, and keeping this file
 * component-only preserves fast refresh.
 */

import type { NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  Archive,
  ArrowRightToLine,
  Bot,
  Brain,
  CircleX,
  Clock,
  Cpu,
  Globe,
  Lock,
  Plug,
  Puzzle,
  Server,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentDiagnostic } from "../../hooks/use-agent-diagnostics";
import { packageDetailPath } from "../../lib/package-paths";

import type { MapEditKind } from "./map-edit-dialog";
import type { MapPanelKind } from "./map-panel-dialog";

import {
  MapCard as Card,
  MapRow as Row,
  MapSectionButton as SectionButton,
  OverflowFadeText,
  type CardAction,
} from "../../components/map-primitives";
export { BoundaryNode } from "../../components/map-primitives";

function diagnosticsFor(diagnostics: AgentDiagnostic[], itemId: string | null): AgentDiagnostic[] {
  return diagnostics.filter((d) => d.target.item === itemId);
}

/** Row-level marker. Tone and copy are carried by the canonical diagnostic. */
function DiagnosticBadge({ diagnostics }: { diagnostics: AgentDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  const blocking = diagnostics.some((diagnostic) => diagnostic.severity === "blocking");
  const Icon = blocking ? CircleX : AlertTriangle;
  return (
    <span
      className={blocking ? "text-destructive shrink-0" : "text-warning shrink-0"}
      title={diagnostics.map((d) => d.explanation).join("\n")}
      aria-label={diagnostics[0]!.explanation}
    >
      <Icon className="size-3.5" />
    </span>
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
  connection_label: string | null;
}
interface ConnectionItem {
  id: string;
  integration_id: string;
  label: string;
  locked: boolean;
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
}
interface ProxyData {
  proxy_id: string | null;
  proxy_name: string | null;
  inherited: boolean;
  resolved: boolean;
}
interface MemoryItem {
  id: string;
  label: string;
  kind: "pinned" | "archive";
  updated_at: string | null;
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

function diagnostics(data: Record<string, unknown>): AgentDiagnostic[] {
  return Array.isArray(data.diagnostics) ? (data.diagnostics as AgentDiagnostic[]) : [];
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

function relationProps(data: Record<string, unknown>, id: string) {
  return {
    relationId: id,
    relationActive: data.relationActive === true,
    onRelationActive:
      typeof data.onRelationActive === "function"
        ? (data.onRelationActive as (relationId: string | null) => void)
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Node renderers
// ---------------------------------------------------------------------------

export function SchedulesNode({ data }: NodeProps) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const list = items<ScheduleItem>(data);
  const diags = diagnostics(data);
  return (
    <Card
      icon={<Clock />}
      title={t("agent-map:schedules")}
      concept="schedules"
      count={list.length}
      sources={["bottom"]}
      emptyLabel={t("agent-map:emptySchedules")}
      // Straight to the create form, agent pre-selected. It used to open a panel
      // that re-listed the schedules this card already shows and offered its own
      // "add" link — two clicks and a duplicated list to reach the one thing a
      // plus can mean.
      action={cardAction(data, "onPanel", "schedules", t("agent-map:addSchedule"))}
      {...relationProps(data, "schedules")}
    >
      {list.map((item) => (
        <Row
          key={item.id}
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
            <span className="flex items-center gap-1">
              {!item.enabled && (
                <span className="text-muted-foreground text-[10px]">{t("agent-map:disabled")}</span>
              )}
              <DiagnosticBadge diagnostics={diagnosticsFor(diags, item.id)} />
            </span>
          }
        />
      ))}
    </Card>
  );
}

export function AgentNode({ data }: NodeProps) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const d = data as unknown as AgentData & {
    diagnostics?: AgentDiagnostic[];
  };
  const diags = diagnostics(data);
  const edit = cardAction(data, "onEdit", "prompt", t("agent-map:editPrompt"), "edit");
  const facts = [d.timeout ? `${d.timeout}s` : null].filter(Boolean);

  return (
    <Card
      icon={<Bot />}
      title={t("agent-map:agent")}
      concept="agent"
      targets={["left", "top"]}
      sources={["right"]}
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
          <div className="text-muted-foreground truncate text-[10px]">{facts.join(" · ")}</div>
        )}
        {/* The prompt is the agent. Clicking the excerpt opens the editor, so
            the content itself is the affordance and the header pencil is only a
            second way in — reaching for a small icon to read more of what is
            right there was the wrong ask. */}
        <SectionButton
          onClick={edit?.onClick}
          className="border-border flex w-full flex-col items-stretch border-t pt-2 text-left"
        >
          <div className="text-muted-foreground mb-1 text-[10px] font-semibold uppercase">
            {t("agent-map:instructions")}
          </div>
          <OverflowFadeText>{d.prompt?.trim() || t("agent-map:noPrompt")}</OverflowFadeText>
        </SectionButton>
      </div>
    </Card>
  );
}

export function ToolboxNode({ data }: NodeProps) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const list = items<ToolboxItem>(data);
  const diags = diagnostics(data);
  const connect = cardAction(data, "onPanel", "connections", t("agent-map:connectAccount"));
  return (
    <Card
      icon={<Plug />}
      title={t("agent-map:toolbox")}
      concept="toolbox"
      count={list.length}
      targets={["top"]}
      emptyLabel={t("agent-map:emptyToolbox")}
      action={cardAction(data, "onEdit", "integrations", t("agent-map:addIntegration"))}
    >
      {list.map((item) => {
        const toolLabel =
          item.tools === "*"
            ? t("agent-map:allTools")
            : item.tools
              ? t("agent-map:toolCount", { count: item.tools.length })
              : t("agent-map:noTools");
        return (
          <Row
            key={item.id}
            label={item.id}
            sublabel={[item.declared_version, toolLabel, item.connection_label]
              .filter(Boolean)
              .join(" · ")}
            dimmed={item.connected === false}
            // Connecting is what a flagged row asks for, and that panel exists —
            // so the row opens it rather than navigating to the integration page.
            {...(connect
              ? { onClick: connect.onClick }
              : { href: packageDetailPath("integration", item.id) })}
            right={
              <span className="flex items-center gap-1">
                {item.locked && (
                  <span className="text-muted-foreground" title={t("agent-map:adminLocked")}>
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

export function ConnectionsNode({ data }: NodeProps) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const list = items<ConnectionItem>(data);
  const browse = cardAction(data, "onPanel", "connections", t("agent-map:connectAccount"));
  return (
    <Card
      icon={<Plug />}
      title={t("agent-map:connections")}
      concept="connections"
      count={list.length}
      sources={["bottom"]}
      emptyLabel={t("agent-map:emptyConnections")}
      action={browse}
      {...relationProps(data, "connections")}
    >
      {list.map((item) => (
        <Row
          key={item.id}
          label={item.label}
          sublabel={item.integration_id}
          onClick={browse?.onClick}
          right={
            item.locked ? (
              <span className="text-muted-foreground" title={t("agent-map:adminLocked")}>
                <Lock className="size-3" />
              </span>
            ) : undefined
          }
        />
      ))}
    </Card>
  );
}

export function SkillsNode({ data }: NodeProps) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const list = items<SkillItem>(data);
  const diags = diagnostics(data);
  const edit = cardAction(data, "onEdit", "skills", t("agent-map:addSkill"));
  return (
    <Card
      icon={<Puzzle />}
      title={t("agent-map:skills")}
      concept="skills"
      count={list.length}
      sources={["left"]}
      emptyLabel={t("agent-map:emptySkills")}
      action={edit}
    >
      {list.map((item) => (
        <Row
          key={item.id}
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
  const { t } = useTranslation(["agents", "agent-map"]);
  const d = data as unknown as ModelData;
  const diags = diagnostics(data);
  // One model, changed rather than added — a pencil, and the row itself opens
  // the same picker so the content is clickable.
  const choose = cardAction(data, "onPanel", "model", t("agent-map:chooseModel"), "edit");
  return (
    <Card
      icon={<Cpu />}
      title={t("agent-map:model")}
      concept="model"
      // An input card: the model feeds the agent (edge `model->agent`).
      sources={["bottom"]}
      // Model and proxy are per-application settings rather than manifest
      // fields, so this mounts the configuration tab's own picker in a dialog.
      action={choose}
      {...relationProps(data, "model")}
    >
      <Row
        label={d.resolved_model_label ?? t("agent-map:noModel")}
        sublabel={
          d.resolved
            ? d.inherited
              ? t("agent-map:modelInherited")
              : t("agent-map:modelPinned")
            : t("agent-map:noModelHint")
        }
        dimmed={!d.resolved}
        onClick={choose?.onClick}
        right={
          <span className="flex items-center gap-1">
            {!d.resolved && diags.length === 0 && (
              <span className="text-warning shrink-0" title={t("agent-map:noModelHint")}>
                <AlertTriangle className="size-3.5" />
              </span>
            )}
            <DiagnosticBadge diagnostics={diags} />
          </span>
        }
      />
    </Card>
  );
}

export function ProxyNode({ data }: NodeProps) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const d = data as unknown as ProxyData;
  const choose = cardAction(data, "onPanel", "proxy", t("agent-map:chooseProxy"), "edit");
  return (
    <Card
      icon={<Globe />}
      title={t("agent-map:proxy")}
      concept="proxy"
      sources={["bottom"]}
      action={choose}
      {...relationProps(data, "proxy")}
    >
      <Row
        label={d.proxy_name ?? d.proxy_id ?? t("agent-map:noProxy")}
        sublabel={d.inherited ? t("agent-map:proxyInherited") : t("agent-map:proxyPinned")}
        dimmed={!d.resolved}
        onClick={choose?.onClick}
      />
    </Card>
  );
}

export function MemoryNode({ data }: NodeProps) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const list = items<MemoryItem>(data);
  const pinnedCount = list.filter((item) => item.kind === "pinned").length;
  const archiveCount = list.filter((item) => item.kind === "archive").length;
  const browse: CardAction = {
    label: t("agent-map:openMemory"),
    icon: "open",
    href: "?agentMemory=pinned#memory",
  };
  return (
    <Card
      icon={<Brain />}
      title={t("agent-map:memory")}
      concept="memory"
      count={list.length}
      targets={["top"]}
      sources={["top"]}
      horizontal
      emptyLabel={t("agent-map:emptyMemory")}
      action={browse}
    >
      {list.length > 0 && (
        <Row
          icon={<Brain className="size-3.5" />}
          label={t("agent-map:memoryPinnedCount", { count: pinnedCount })}
          href="?agentMemory=pinned#memory"
        />
      )}
      {list.length > 0 && (
        <Row
          icon={<Archive className="size-3.5" />}
          label={t("agent-map:memoryArchiveCount", { count: archiveCount })}
          href="?agentMemory=archive#memory"
        />
      )}
    </Card>
  );
}

export function SystemToolsNode({ data }: NodeProps) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const list = items<SystemToolItem>(data);
  // A checklist you tick, not a list you append to.
  const grant = cardAction(
    data,
    "onEdit",
    "runtime_tools",
    t("agent-map:grantSystemTools"),
    "edit",
  );
  return (
    <Card
      icon={<Wrench />}
      title={t("agent-map:systemTools")}
      concept="systemTools"
      count={list.length}
      sources={["left"]}
      emptyLabel={t("agent-map:emptySystemTools")}
      // These are granted in the manifest (`runtime_tools`), so the affordance
      // opens the same checklist the editor uses.
      action={grant}
    >
      {list.map((item) => (
        <Row
          key={item.id}
          label={t(`agent-map:systemTool.${item.id}`, {
            defaultValue: item.id,
          })}
          sublabel={item.always ? t("agent-map:toolAlways") : t("agent-map:toolGranted")}
          // An always-on tool is not in the checklist, so sending its row there
          // would open a dialog that cannot show it.
          onClick={item.always ? undefined : grant?.onClick}
        />
      ))}
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
  const { t } = useTranslation(["agents", "agent-map"]);
  const list = items<ContractField>(data);
  // A schema is one shape you reshape, not a list you append to — hence the
  // pencil, and rows that open the same field editor the package editor uses.
  const edit = cardAction(
    data,
    "onEdit",
    side,
    side === "input" ? t("agent-map:editInput") : t("agent-map:editOutput"),
    "edit",
  );
  return (
    <Card
      icon={side === "input" ? <ArrowRightToLine /> : <Sparkles />}
      title={side === "input" ? t("agent-map:input") : t("agent-map:output")}
      concept={side}
      count={list.length}
      {...(side === "input"
        ? { targets: ["left" as const, "top" as const], sources: ["right" as const] }
        : { targets: ["left" as const] })}
      emptyLabel={side === "input" ? t("agent-map:emptyInput") : t("agent-map:emptyOutput")}
      action={edit}
    >
      {list.map((field) => (
        <Row
          key={field.name}
          label={field.title ?? field.name}
          sublabel={[field.type, field.required ? t("agent-map:fieldRequired") : null]
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
export function InputValuesNode({ data }: NodeProps) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const list = items<ConfigItem>(data);
  const diags = diagnostics(data);
  const setValues = cardAction(data, "onPanel", "config", t("agent-map:editConfig"), "edit");
  return (
    <Card
      icon={<SlidersHorizontal />}
      title={t("agent-map:inputValues")}
      concept="config"
      count={list.length}
      sources={["bottom"]}
      emptyLabel={t("agent-map:emptyConfig")}
      action={list.length > 0 ? setValues : undefined}
      {...relationProps(data, "input_values")}
    >
      {list.map((field) => (
        <Row
          key={field.name}
          label={field.title ?? field.name}
          // The value is the point of this card; the type only matters when
          // there is no value to show yet.
          sublabel={field.value ?? t("agent-map:configUnset")}
          dimmed={field.value === null}
          onClick={setValues?.onClick}
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
  const { t } = useTranslation(["agents", "agent-map"]);
  const list = items<McpServerItem>(data);
  const diags = diagnostics(data);
  return (
    <Card
      icon={<Server />}
      title={t("agent-map:mcpServers")}
      concept="mcpServers"
      count={list.length}
      sources={["left"]}
      emptyLabel={t("agent-map:emptyMcpServers")}
    >
      {list.map((item) => (
        <Row
          key={item.id}
          label={item.id}
          sublabel={item.version}
          href={packageDetailPath("mcp-server", item.id)}
          right={<DiagnosticBadge diagnostics={diagnosticsFor(diags, item.id)} />}
        />
      ))}
    </Card>
  );
}
