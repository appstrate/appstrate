// SPDX-License-Identifier: Apache-2.0

import { useId, type Dispatch, type ReactNode } from "react";
import { ActivityIcon, ChevronRightIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNowTick } from "@appstrate/ui/use-now-tick";
import { useSessionDetail } from "@appstrate/module-chat/unread";
import {
  conversationStats,
  type ConversationStats,
} from "@appstrate/module-chat/conversation-stats";
import type {
  ConversationToolCall,
  ConversationTools,
} from "@appstrate/module-chat/conversation-tools";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { CopyButton } from "@appstrate/ui/components/copy-button";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";
import { MimeIcon } from "@appstrate/ui/components/mime-icon";
import { formatCompactTokens, formatTokenFigure } from "@appstrate/ui/context-window";
import {
  IntegrationLogoStack,
  IntegrationLogoStackSkeleton,
} from "../../components/integration-logo-stack";
import { ErrorState } from "../../components/page-states";
import { RowSpaceName, RunLink } from "../../components/run-row";
import { RunStatusBadge } from "../../components/status-badge";
import { Waiting } from "../../components/loading-skeletons";
import { SkeletonLine } from "../../components/skeleton-line";
import { formatBytes } from "../../lib/format-bytes";
import { formatDateField, formatRelativeTime } from "../../lib/format-date";
import { ChatAccessSummary } from "./chat-access-summary";
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
import {
  TOOL_STATUS_LABEL,
  TOOL_STATUS_TONE,
  useConversationTools,
  useToolLabel,
} from "./use-conversation-tools";
import { useSummarySections, type SummarySectionId } from "./use-summary-sections";
import { useConversationTabs } from "./use-conversation-tabs";

function InfoDate({ iso }: { iso: string }) {
  const now = useNowTick();
  return (
    <>
      <span>{formatRelativeTime(iso, now, "long")}</span>
      <span className="text-muted-foreground block text-xs">{formatDateField(iso)}</span>
    </>
  );
}

function ConversationId({ id }: { id: string }) {
  const { t } = useTranslation(["chat", "common"]);
  return (
    <div className="text-muted-foreground flex items-center gap-1 text-xs">
      <code className="min-w-0 flex-1 truncate font-mono">{id}</code>
      <CopyButton
        value={id}
        className="desktop-pointer:size-6 shrink-0"
        aria-label={`${t("common:btn.copy")} (${t("chat:context.summary.id")})`}
      />
    </div>
  );
}

/** The latest lines each group of the activity draws before its "See all". */
const SUMMARY_ROWS = 3;

/**
 * Whether a call reached a connected integration, read off its tool: a call still running, one
 * refused before it resolved, or one stored before presentations existed carries no subject.
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

const DISCLOSURE_LINE_CLASS = "flex min-h-10 w-full items-center justify-start gap-2 px-4 py-2";

const SECTIONS: readonly { id: SummarySectionId; width: string }[] = [
  { id: "usage", width: "w-28" },
  { id: "access", width: "w-24" },
  { id: "details", width: "w-16" },
];

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

/**
 * The summary while the conversation loads: its header lines, its activity, its sections as the
 * reader left them, folded to their line or open on their content.
 */
function SummarySkeleton({ sections }: { sections: ReturnType<typeof useSummarySections> }) {
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
        {SECTIONS.map(({ id, width }) => (
          <div key={id}>
            <div className={DISCLOSURE_LINE_CLASS}>
              <span className="size-4 shrink-0" />
              <SkeletonLine className={cn("text-sm font-medium", width)} />
            </div>
            {sections.isOpen(id) ? (
              <div className="flex flex-col gap-1 px-4 pt-1 pb-3">
                {["w-1/3", "w-2/3", "w-1/2"].map((line) => (
                  <SkeletonLine key={line} className={cn("text-sm", line)} />
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Waiting>
  );
}

/**
 * The models that closed the conversation's turns and the context it carries, from the turns' own
 * metadata, beside the tokens every metered call consumed, from the server's ledger sum.
 */
export function ConversationUsage({
  session,
  stats: { models, context },
}: {
  session: NonNullable<ReturnType<typeof useSessionDetail>["data"]>;
  stats: ConversationStats;
}) {
  const { t, i18n } = useTranslation("chat");
  const { usage } = session;
  const read =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  const generated = usage.output_tokens ?? 0;
  const metered = read + generated > 0;

  return (
    <div className="flex flex-col gap-2">
      {models.length === 0 && !context && !metered ? (
        <p className="text-muted-foreground text-sm">{t("context.summary.noTurn")}</p>
      ) : (
        <>
          <FactGrid columns={1}>
            {context ? (
              <Fact label={t("context.summary.currentContext")}>
                <span className="whitespace-nowrap tabular-nums">
                  {t("contextUsage.counts", {
                    used: formatCompactTokens(context.tokens, i18n.language),
                    max: formatTokenFigure(
                      context.window,
                      context.windowAssumed === true,
                      i18n.language,
                    ),
                  })}
                </span>
                {context.windowAssumed === true ? (
                  <span className="text-muted-foreground block text-xs">
                    {t("contextUsage.windowAssumed", {
                      window: formatCompactTokens(context.window, i18n.language),
                    })}
                  </span>
                ) : null}
              </Fact>
            ) : null}
            {models.length > 0 ? (
              <Fact label={t("context.summary.models", { count: models.length })}>
                <ul className="flex flex-col gap-0.5">
                  {models.map((model) => (
                    <li key={model.modelId}>
                      {model.failed > 0
                        ? t("context.summary.modelTurnsFailed", {
                            model: model.label,
                            count: model.turns,
                            failed: model.failed,
                          })
                        : t("context.summary.modelTurns", {
                            model: model.label,
                            count: model.turns,
                          })}
                    </li>
                  ))}
                </ul>
              </Fact>
            ) : null}
            {metered ? (
              <Fact label={t("context.summary.tokens")}>
                {t("context.summary.tokensReadGenerated", {
                  read: formatCompactTokens(read, i18n.language),
                  generated: formatCompactTokens(generated, i18n.language),
                })}
              </Fact>
            ) : null}
          </FactGrid>
          {metered ? (
            <p className="text-muted-foreground text-xs">{t("context.summary.tokensScope")}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * A folding section: one line naming it and its gist, so the folded summary reads at a glance;
 * unfolded, its content in place.
 */
function SummaryDisclosure({
  title,
  preview,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  /** The section's gist, on the folded line. */
  preview?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <section>
        <h3>
          <CollapsibleTrigger
            className={cn(
              DISCLOSURE_LINE_CLASS,
              "hover:bg-muted/50 focus-visible:ring-ring text-left transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset",
            )}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "text-muted-foreground duration-fast ease-surface size-4 shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 text-sm font-medium">{title}</span>
            {preview ? (
              <span className="text-muted-foreground ml-auto min-w-0 truncate pl-2 text-xs font-normal">
                {preview}
              </span>
            ) : null}
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent className="px-4 pt-1 pb-3">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function folding(sections: ReturnType<typeof useSummarySections>, id: SummarySectionId) {
  return { open: sections.isOpen(id), onOpenChange: () => sections.toggle(id) };
}

/**
 * One item of the activity on one line: its icon, its name, what it acted on, the space it is in
 * (a list spanning spaces), then its outcome. Laid in its line's own flex row.
 */
function ActivityLine({
  icon,
  label,
  detail,
  space,
  trailing,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  space?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <>
      <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
        {icon}
      </span>
      {/* The detail takes only the room left (basis 0): the name truncates once it has none, never over the outcome. */}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 truncate font-medium">{label}</span>
        {detail ? (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{detail}</span>
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
 * A run on one line, leading to its page as the Runs tab's rows do (`RunLink`), naming its space
 * in a list spanning spaces.
 */
function RunLine({
  run,
  agentName,
  spanning,
}: {
  run: ConversationRun;
  agentName: string;
  spanning: boolean;
}) {
  return (
    <RunLink run={run} className={LINE_CLASS}>
      <ActivityLine
        icon={<ActivityIcon />}
        label={agentName}
        detail={`#${run.runNumber}`}
        space={spanning ? <RowSpaceName spaceId={run.spaceId} /> : null}
        trailing={<RunStatusBadge status={run.status} unread={run.unread} compact />}
      />
    </RunLink>
  );
}

/** A call on one line, opening its detail in the Tools tab; its outcome when it is not a success. */
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
      onClick={() =>
        dispatch({ type: "show-tool-call", toolCallId: call.toolCallId, from: "summary" })
      }
    >
      <ActivityLine
        icon={<ToolCallIcon call={call} shown={shown} />}
        label={shown.label}
        detail={shown.idText}
        trailing={
          call.status === "success" ? null : (
            <span className={cn("text-xs", TOOL_STATUS_TONE[call.status])}>
              {t(TOOL_STATUS_LABEL[call.status])}
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
      <ActivityLine
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
function ActivityGroup({
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
        <p className="text-muted-foreground px-4 py-3 text-sm">{t("context.summary.noActivity")}</p>
      ) : (
        <div className="flex flex-col gap-1 py-2">
          {runsRead === "pending" ? <GroupSkeleton /> : null}
          {runsRead === "error" ? (
            <ActivityGroup title={t("common:nav.runs")}>
              <ErrorState error={runs.query.error} compact />
            </ActivityGroup>
          ) : null}
          {runRows.length > 0 ? (
            <ActivityGroup
              title={t("common:nav.runs")}
              total={runs.total}
              onSeeAll={runs.total > SUMMARY_ROWS ? seeAll("runs") : undefined}
            >
              {runRows.map((run) => (
                <RunLine
                  key={run.id}
                  run={run}
                  agentName={runs.agentName(run)}
                  spanning={runs.spanning}
                />
              ))}
            </ActivityGroup>
          ) : null}
          {filesRead === "pending" ? <GroupSkeleton /> : null}
          {filesRead === "error" ? (
            <ActivityGroup title={t("common:nav.files")}>
              <ErrorState error={files.query.error} compact />
            </ActivityGroup>
          ) : null}
          {fileRows.length > 0 ? (
            <ActivityGroup
              title={t("common:nav.files")}
              onSeeAll={
                files.hasMore || files.files.length > SUMMARY_ROWS ? seeAll("files") : undefined
              }
            >
              {fileRows.map((file) => (
                <FileLine key={file.id} file={file} dispatch={dispatch} />
              ))}
            </ActivityGroup>
          ) : null}
          {reachedRead === "pending" && callRows.length === 0 ? <GroupSkeleton /> : null}
          {showsIntegrations ? (
            <ActivityGroup
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
              onSeeAll={calls.length > SUMMARY_ROWS ? seeAll("tools") : undefined}
            >
              {reachedRead === "error" ? <ErrorState error={reached.query.error} compact /> : null}
              {callRows.map((call) => (
                <CallLine key={call.toolCallId} call={call} dispatch={dispatch} />
              ))}
            </ActivityGroup>
          ) : null}
        </div>
      )}
    </>
  );
}

/**
 * The conversation in one view: its title and gist, then all it did (runs, files, integration
 * calls) on one line each, each group leading to its tab; its models, the reader's access and its
 * details fold to one line each.
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
  const sections = useSummarySections();
  const query = useSessionDetail(conversationId, { enabled: active });
  const { tools } = useConversationTools(conversationId, active);
  const { tabs } = useConversationTabs("summary");
  const shows = (tab: ConversationSidebarTab) => tabs.some(({ id }) => id === tab);
  const seeAll = (tab: ConversationSidebarTab) => () => dispatch({ type: "select-tab", tab });
  // The access judges the conversation's own scope: the same query as the header's.
  const access = (conversation: Parameters<typeof ChatAccessSummary>[0]["conversation"]) => (
    <SummaryDisclosure title={t("context.summary.access")} {...folding(sections, "access")}>
      <ChatAccessSummary conversation={conversation} />
    </SummaryDisclosure>
  );

  if (!conversationId) {
    return (
      <div className="divide-y">
        <p className="text-muted-foreground p-4 text-sm">{t("context.unsaved")}</p>
        {access(null)}
      </div>
    );
  }
  // A refetch that fails keeps the conversation already read.
  if (query.data === undefined && query.error) return <ErrorState error={query.error} compact />;
  // Not read yet, or held while the panel is closed: never an error.
  if (query.data === undefined || tools === undefined) {
    return <SummarySkeleton sections={sections} />;
  }
  // The server holds no such conversation.
  if (query.data === null || tools === null) return <ErrorState compact />;

  const session = query.data;
  const title = session.title || t("context.summary.untitled");
  const stats = conversationStats(session.messages);
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
      <SummaryDisclosure
        title={t("context.summary.usageTitle")}
        preview={stats.models.map((model) => model.label).join(", ") || undefined}
        {...folding(sections, "usage")}
      >
        <ConversationUsage session={session} stats={stats} />
      </SummaryDisclosure>
      {access(session)}
      <SummaryDisclosure title={t("context.summary.details")} {...folding(sections, "details")}>
        <div className="flex flex-col gap-3">
          <FactGrid columns={1}>
            <Fact label={t("context.summary.created")}>
              <InfoDate iso={session.createdAt} />
            </Fact>
          </FactGrid>
          <ConversationId id={conversationId} />
        </div>
      </SummaryDisclosure>
    </div>
  );
}
