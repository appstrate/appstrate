// SPDX-License-Identifier: Apache-2.0

import { useId, type Dispatch, type ReactNode } from "react";
import { LayoutListIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentListItem } from "@appstrate/shared-types";
import { useNowTick } from "@appstrate/ui/use-now-tick";
import { useSessionDetail } from "@appstrate/module-chat/unread";
import type {
  ConversationToolCall,
  ConversationTools,
} from "@appstrate/module-chat/conversation-tools";
import { ActivityId, ActivityLead, FailedGlyph } from "@appstrate/module-chat/activity-line";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { MimeIcon } from "@appstrate/ui/components/mime-icon";
import {
  IntegrationLogoStack,
  IntegrationLogoStackSkeleton,
} from "@appstrate/ui/components/integration-logo-stack";
import { EmptyState, ErrorState } from "../../components/page-states";
import { PackageIcon } from "../../components/package-icon";
import { RowSpaceName } from "../../components/run-row";
import { RunStatusBadge } from "../../components/status-badge";
import { Waiting } from "../../components/loading-skeletons";
import { SkeletonLine } from "../../components/skeleton-line";
import { formatBytes } from "../../lib/format-bytes";
import { formatDateField, formatRelativeTime } from "../../lib/format-date";
import type {
  ConversationSidebarAction,
  ConversationSidebarTab,
} from "./conversation-sidebar-state";
import { ToolCallIcon } from "./conversation-tools-tab";
import {
  readShown,
  useConversationFiles,
  useConversationIntegrations,
  useConversationRuns,
} from "./use-conversation-lists";
import { TOOL_STATUS_LABEL, useConversationTools, useToolLabel } from "./use-conversation-tools";
import { useConversationTabs } from "./use-conversation-tabs";

/** The latest lines each group of the activity draws before its "See all". */
const SUMMARY_ROWS = 3;

/**
 * Whether a call reached a connected integration, read off its tool: a call still running or one
 * refused before it resolved carries no subject.
 */
function reachedIntegration({ toolName }: ConversationToolCall): boolean {
  return toolName === "call_integration_tool";
}

/** A line of the summary's activity: 40 px, a touch target like every chat control. */
const LINE_CLASS = "flex min-h-10 w-full items-center gap-2.5 px-4 py-1.5 text-left text-sm";

/** A line that opens something in the panel: it hovers like a list row. */
const BUTTON_LINE_CLASS = cn(LINE_CLASS, "hover:bg-muted/50 transition-colors");

/** A group's heading line: as tall as its "See all" on touch, denser under a mouse. */
const GROUP_HEAD_CLASS = "desktop-pointer:min-h-7 flex min-h-10 items-center gap-1.5 px-4";

/**
 * One group of the activity on its way, in its shape: its heading and its lines. Hidden from
 * assistive tech: the zone that waits says so once.
 */
function GroupSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col">
      <div className={GROUP_HEAD_CLASS}>
        <SkeletonLine className="w-12 text-xs font-medium" />
      </div>
      {["w-32", "w-40", "w-28"].slice(0, SUMMARY_ROWS).map((width) => (
        <div key={width} className={LINE_CLASS}>
          <SkeletonLine className="w-4" />
          <SkeletonLine className={cn("font-medium", width)} />
        </div>
      ))}
    </div>
  );
}

/** The summary while the conversation loads: its header lines, then its activity. */
function SummarySkeleton() {
  return (
    <Waiting>
      <div className="divide-y">
        <div className="flex flex-col gap-0.5 px-4 py-3">
          <SkeletonLine className="w-2/3 text-sm font-semibold" />
          <SkeletonLine className="w-1/2 text-xs" />
        </div>
        <div className="py-2">
          <GroupSkeleton />
        </div>
      </div>
    </Waiting>
  );
}

/**
 * One item of the activity on one line: its icon, its name, what it acted on, the space it is in
 * (a list spanning spaces), then its outcome. Laid in its line's own flex row.
 */
function SummaryLine({
  icon,
  bareIcon,
  label,
  detail,
  space,
  trailing,
}: {
  icon: ReactNode;
  /** The icon sizes itself (an identity tile), so the lead does not force its glyph to 16px. */
  bareIcon?: boolean;
  label: string;
  detail?: ReactNode;
  space?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <>
      <ActivityLead className={cn("text-muted-foreground", bareIcon && "[&_svg]:size-auto")}>
        {icon}
      </ActivityLead>
      {/* The detail takes only the room left (basis 0): the name truncates once it has none, never over the outcome. */}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 truncate font-medium">{label}</span>
        {detail ? (
          <span className="text-muted-foreground flex min-w-0 flex-1">{detail}</span>
        ) : null}
      </span>
      {space}
      {trailing ? <span className="flex shrink-0 items-center">{trailing}</span> : null}
    </>
  );
}

type ConversationRun = ReturnType<typeof useConversationRuns>["runs"][number];
type ConversationFile = ReturnType<typeof useConversationFiles>["files"][number];

/**
 * A run on one line, led by its agent's tile and opening on its line of the Runs tab, naming its
 * space in a list spanning spaces. Its page is one click away in the open run.
 */
function SummaryRunLine({
  run,
  agentName,
  agent,
  spanning,
  dispatch,
}: {
  run: ConversationRun;
  agentName: string;
  agent: AgentListItem | undefined;
  spanning: boolean;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  return (
    <button
      type="button"
      className={BUTTON_LINE_CLASS}
      onClick={() => dispatch({ type: "show-item", item: { kind: "run", id: run.id } })}
    >
      <SummaryLine
        bareIcon
        icon={
          <PackageIcon
            type="agent"
            id={run.packageId ?? agentName}
            name={agentName}
            icon={agent?.icon}
            color={agent?.color}
            size="xs"
          />
        }
        label={agentName}
        detail={
          run.runNumber != null ? (
            <span className="min-w-0 truncate text-xs">{`#${run.runNumber}`}</span>
          ) : null
        }
        space={spanning ? <RowSpaceName spaceId={run.spaceId} /> : null}
        trailing={<RunStatusBadge status={run.status} unread={run.unread} compact />}
      />
    </button>
  );
}

/** A call on one line, opening it on its line of the Tools tab; its outcome when it is not a success. */
function CallLine({
  call,
  dispatch,
}: {
  call: ConversationToolCall;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const shown = useToolLabel()(call);
  return (
    <button
      type="button"
      className={BUTTON_LINE_CLASS}
      onClick={() => dispatch({ type: "show-item", item: { kind: "call", id: call.toolCallId } })}
    >
      <SummaryLine
        icon={<ToolCallIcon shown={shown} />}
        label={shown.label}
        detail={shown.idText ? <ActivityId>{shown.idText}</ActivityId> : undefined}
        trailing={
          call.status === "success" ? null : (
            <span className="flex items-center gap-1">
              {call.status === "error" ? <FailedGlyph /> : null}
              <span className="text-muted-foreground text-xs">
                {t(TOOL_STATUS_LABEL[call.status])}
              </span>
            </span>
          )
        }
      />
    </button>
  );
}

/** A file on one line, opening it over the Files tab, back to the summary once closed. */
function FileLine({
  file,
  dispatch,
}: {
  file: ConversationFile;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  return (
    <button
      type="button"
      className={BUTTON_LINE_CLASS}
      onClick={() =>
        dispatch({
          type: "show-file",
          file: { id: file.id, name: file.name, spaceId: file.spaceId },
          from: "summary",
        })
      }
    >
      <SummaryLine
        icon={<MimeIcon mime={file.mime} name={file.name} />}
        label={file.name}
        trailing={
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatBytes(file.size)}
          </span>
        }
      />
    </button>
  );
}

/**
 * A group of the activity, a section named by its heading: its name, its latest lines, and, when
 * it holds more (`onSeeAll`), "See all" to its tab, with `total` when the server counts it.
 */
function SummaryGroup({
  title,
  aside,
  total,
  onSeeAll,
  children,
}: {
  title: string;
  /** Beside the heading: what the whole group stands for. */
  aside?: ReactNode;
  total?: number;
  onSeeAll?: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const headingId = useId();
  return (
    <section className="flex flex-col" aria-labelledby={headingId}>
      <div className={GROUP_HEAD_CLASS}>
        <h3 id={headingId} className="text-muted-foreground text-xs font-medium">
          {title}
        </h3>
        {aside}
        {onSeeAll ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground desktop-pointer:h-6 ml-auto h-10 px-1.5 text-xs tabular-nums"
            onClick={onSeeAll}
          >
            {total === undefined
              ? t("context.summary.seeAll")
              : t("context.summary.seeAllCount", { count: total })}
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * What the conversation did, in one view: its runs, its files and its integration calls (lookups
 * included), the latest of each on one line; the integrations it reached, its runs' included (the
 * call journal), stack their logos beside the « Intégrations » heading. A group with nothing in it is left out; a group whose
 * tab the reader cannot see too. Each group stands on its own read: the calls, held by the
 * conversation, show at once; a group whose read is on its way waits in its shape, one whose read
 * failed with nothing held says so in its place. The zone says it waits once, whatever waits.
 */
function SummaryActivity({
  conversationId,
  active,
  tools,
  showsRuns,
  showsFiles,
  seeAll,
  dispatch,
}: {
  conversationId: string;
  active: boolean;
  tools: ConversationTools;
  showsRuns: boolean;
  showsFiles: boolean;
  seeAll: (tab: ConversationSidebarTab) => () => void;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const runs = useConversationRuns(conversationId, active && showsRuns);
  const files = useConversationFiles(conversationId, active && showsFiles);
  const reached = useConversationIntegrations(conversationId, active);
  const runsRead = showsRuns ? readShown(runs.query) : null;
  const filesRead = showsFiles ? readShown(files.query) : null;
  const reachedRead = readShown(reached.query);
  const runRows = runsRead === "ready" ? runs.runs.slice(0, SUMMARY_ROWS) : [];
  const fileRows = filesRead === "ready" ? files.files.slice(0, SUMMARY_ROWS) : [];
  const calls = tools.calls.filter(reachedIntegration).reverse();
  const callRows = calls.slice(0, SUMMARY_ROWS);
  const waiting = runsRead === "pending" || filesRead === "pending" || reachedRead === "pending";
  const showsIntegrations =
    callRows.length > 0 || reached.integrations.length > 0 || reachedRead === "error";
  const nothing =
    runRows.length + fileRows.length === 0 &&
    !showsIntegrations &&
    !waiting &&
    runsRead !== "error" &&
    filesRead !== "error";

  return (
    <>
      {waiting ? (
        <span role="status" className="sr-only">
          {t("common:loading")}
        </span>
      ) : null}
      {nothing ? (
        <EmptyState
          message={t("context.summary.noActivity")}
          hint={t("context.summary.noActivityHint")}
          icon={LayoutListIcon}
          compact
        />
      ) : (
        <div className="flex flex-col gap-1 py-2">
          {runsRead === "pending" ? <GroupSkeleton /> : null}
          {runsRead === "error" ? (
            <SummaryGroup title={t("common:nav.runs")}>
              <ErrorState error={runs.query.error} compact />
            </SummaryGroup>
          ) : null}
          {runRows.length > 0 ? (
            <SummaryGroup
              title={t("common:nav.runs")}
              total={runs.total}
              onSeeAll={runs.total > SUMMARY_ROWS ? seeAll("runs") : undefined}
            >
              {runRows.map((run) => (
                <SummaryRunLine
                  key={run.id}
                  run={run}
                  agentName={runs.agentName(run)}
                  agent={run.packageId ? runs.agentById.get(run.packageId) : undefined}
                  spanning={runs.spanning}
                  dispatch={dispatch}
                />
              ))}
            </SummaryGroup>
          ) : null}
          {filesRead === "pending" ? <GroupSkeleton /> : null}
          {filesRead === "error" ? (
            <SummaryGroup title={t("common:nav.files")}>
              <ErrorState error={files.query.error} compact />
            </SummaryGroup>
          ) : null}
          {fileRows.length > 0 ? (
            <SummaryGroup
              title={t("common:nav.files")}
              onSeeAll={
                files.hasMore || files.files.length > SUMMARY_ROWS ? seeAll("files") : undefined
              }
            >
              {fileRows.map((file) => (
                <FileLine key={file.id} file={file} dispatch={dispatch} />
              ))}
            </SummaryGroup>
          ) : null}
          {reachedRead === "pending" && callRows.length === 0 ? <GroupSkeleton /> : null}
          {showsIntegrations ? (
            <SummaryGroup
              title={t("context.summary.integrations")}
              aside={
                reachedRead === "pending" ? (
                  <IntegrationLogoStackSkeleton />
                ) : (
                  <IntegrationLogoStack
                    integrations={reached.integrations.map((integration) => ({
                      id: integration.id,
                      name: integration.display_name,
                      icon: integration.icon,
                    }))}
                  />
                )
              }
              onSeeAll={
                calls.length > SUMMARY_ROWS
                  ? () => {
                      if (calls.some((call) => call.lookup)) {
                        dispatch({ type: "show-lookups", show: true });
                      }
                      dispatch({ type: "select-tab", tab: "tools" });
                    }
                  : undefined
              }
            >
              {reachedRead === "error" ? <ErrorState error={reached.query.error} compact /> : null}
              {callRows.map((call) => (
                <CallLine key={call.toolCallId} call={call} dispatch={dispatch} />
              ))}
            </SummaryGroup>
          ) : null}
        </div>
      )}
    </>
  );
}

/**
 * The conversation in one view: its title and gist, then all it did (runs, files, integration
 * calls) on one line each, each group leading to its tab.
 */
export function ConversationSummary({
  conversationId,
  active,
  dispatch,
}: {
  conversationId: string | null;
  active: boolean;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const now = useNowTick();
  const query = useSessionDetail(conversationId, { enabled: active });
  const { tools } = useConversationTools(conversationId, active);
  const { tabs } = useConversationTabs("summary");
  const shows = (tab: ConversationSidebarTab) => tabs.some(({ id }) => id === tab);
  const seeAll = (tab: ConversationSidebarTab) => () => dispatch({ type: "select-tab", tab });

  if (!conversationId) {
    return <EmptyState message={t("context.unsaved")} icon={LayoutListIcon} compact />;
  }
  // A refetch that fails keeps the conversation already read.
  if (query.data === undefined && query.error) return <ErrorState error={query.error} compact />;
  // Not read yet, or held while the panel is closed: never an error.
  if (query.data === undefined || tools === undefined) return <SummarySkeleton />;
  // The server holds no such conversation.
  if (query.data === null || tools === null) return <ErrorState compact />;

  const session = query.data;
  const title = session.title || t("context.summary.untitled");
  const gist = [
    t("context.summary.messages", { count: session.messages.length }),
    session.generating ? t("context.summary.generating") : null,
    formatRelativeTime(session.updatedAt, now, "long"),
  ].filter(Boolean);

  return (
    <div className="divide-y">
      <div className="flex flex-col gap-0.5 px-4 py-3">
        <h3 className="truncate text-sm font-semibold" title={title}>
          {title}
        </h3>
        <p className="text-muted-foreground text-xs" title={formatDateField(session.updatedAt)}>
          {gist.join(" · ")}
        </p>
      </div>
      <SummaryActivity
        conversationId={conversationId}
        active={active}
        tools={tools}
        showsRuns={shows("runs")}
        showsFiles={shows("files")}
        seeAll={seeAll}
        dispatch={dispatch}
      />
    </div>
  );
}
