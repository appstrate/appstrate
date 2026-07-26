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
  Clock,
  Lock,
  MessageSquare,
  Play,
  Plug,
  Puzzle,
  Server,
  Terminal,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentMapDiagnostic } from "../../hooks/use-agent-map";

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

function Card({
  title,
  count,
  children,
  hasIncoming,
  hasOutgoing,
  wide,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  hasIncoming?: boolean;
  hasOutgoing?: boolean;
  wide?: boolean;
}) {
  return (
    <div
      className={`border-border bg-card rounded-lg border shadow-sm ${wide ? "w-[340px]" : "w-[300px]"}`}
    >
      {hasIncoming && <Handle type="target" position={Position.Left} className="!bg-border" />}
      {hasOutgoing && <Handle type="source" position={Position.Right} className="!bg-border" />}
      <div className="border-border flex items-center justify-between border-b px-3 py-2">
        <span className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
          {title}
        </span>
        {count !== undefined && <span className="text-muted-foreground text-[11px]">{count}</span>}
      </div>
      <div className={`${MAX_LIST_HEIGHT} overflow-y-auto p-2`}>{children}</div>
    </div>
  );
}

function Row({
  icon,
  label,
  sublabel,
  right,
  dimmed,
}: {
  icon?: React.ReactNode;
  label: string;
  sublabel?: string | null;
  right?: React.ReactNode;
  dimmed?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${dimmed ? "opacity-50" : ""}`}>
      {icon && <span className="text-muted-foreground shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{label}</div>
        {sublabel && <div className="text-muted-foreground truncate text-[11px]">{sublabel}</div>}
      </div>
      {right}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item shapes
//
// `data` is polymorphic on the wire (`additionalProperties: true`), so each
// renderer narrows to the shape its own node type emits. The server is the
// single author of these objects — see `services/agent-map.ts`.
// ---------------------------------------------------------------------------

interface TriggerItem {
  kind: string;
  configured: boolean;
  accepts_input?: boolean;
}
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

const TRIGGER_ICONS: Record<string, React.ReactNode> = {
  manual: <Play className="size-3.5" />,
  schedule: <Clock className="size-3.5" />,
  api: <Terminal className="size-3.5" />,
  chat: <MessageSquare className="size-3.5" />,
};

// ---------------------------------------------------------------------------
// Node renderers
// ---------------------------------------------------------------------------

export function TriggersNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<TriggerItem>(data);
  return (
    <Card title={t("map.triggers")} hasOutgoing>
      {list.map((item) => (
        <Row
          key={item.kind}
          icon={TRIGGER_ICONS[item.kind]}
          label={t(`map.trigger.${item.kind}`, { defaultValue: item.kind })}
          sublabel={
            item.configured
              ? t(`map.triggerHint.${item.kind}`, { defaultValue: null })
              : t("map.notConfigured")
          }
          dimmed={!item.configured}
        />
      ))}
    </Card>
  );
}

export function SchedulesNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<ScheduleItem>(data);
  return (
    <Card title={t("map.schedules")} count={list.length} hasOutgoing>
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
    <Card title={t("map.agent")} hasIncoming hasOutgoing wide>
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
    <Card title={t("map.toolbox")} count={list.length} hasIncoming>
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
    <Card title={t("map.skills")} count={list.length} hasIncoming>
      {list.map((item) => (
        <Row
          key={item.id}
          icon={<Puzzle className="size-3.5" />}
          label={item.name ?? item.id}
          sublabel={item.declared_version}
          dimmed={!item.resolved}
          right={<DiagnosticBadge diagnostics={diagnosticsFor(diags, item.id)} />}
        />
      ))}
    </Card>
  );
}

export function McpServersNode({ data }: NodeProps) {
  const { t } = useTranslation("agents");
  const list = items<McpServerItem>(data);
  const diags = diagnostics(data);
  return (
    <Card title={t("map.mcpServers")} count={list.length} hasIncoming>
      {list.map((item) => (
        <Row
          key={item.id}
          icon={<Server className="size-3.5" />}
          label={item.id}
          sublabel={item.version}
          right={<DiagnosticBadge diagnostics={diagnosticsFor(diags, item.id)} />}
        />
      ))}
    </Card>
  );
}
