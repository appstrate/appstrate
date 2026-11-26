// SPDX-License-Identifier: Apache-2.0

import type { Dispatch, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ActivityIcon, ChevronRightIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNowTick } from "@appstrate/ui/use-now-tick";
import { useSessionDetail } from "@appstrate/module-chat/unread";
import { conversationStats } from "@appstrate/module-chat/conversation-stats";
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
import { ErrorState } from "../../components/page-states";
import { IntegrationLogoStack } from "../../components/integration-logo-stack";
import { RunStatusBadge } from "../../components/status-badge";
import { Waiting } from "../../components/loading-skeletons";
import { SkeletonLine } from "../../components/skeleton-line";
import { useSpaceLink } from "../../hooks/use-current-space";
import { formatBytes } from "../../lib/format-bytes";
import { runDetailPath } from "../../lib/package-paths";
import { formatDateField, formatRelativeTime } from "../../lib/format-date";
import { ChatAccessSummary } from "./chat-access-summary";
import type {
  ConversationSidebarAction,
  ConversationSidebarTab,
} from "./conversation-sidebar-state";
import { ToolCallIcon } from "./conversation-tools-tab";
import { SUMMARY_ROWS, summaryModel, type SummaryGroup } from "./summary-model";
import {
  FAILED_RUN_STATUSES,
  useConversationFiles,
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

/** A line of the summary's activity: 40 px, a touch target like every chat control. */
const ROW_CLASS =
  "hover:bg-muted/50 flex min-h-10 w-full items-center gap-2.5 px-4 py-1.5 text-left text-sm transition-colors";

/** A group's heading line: as tall as its "See all" on touch, denser under a mouse. */
const GROUP_HEAD_CLASS = "desktop-pointer:min-h-7 flex min-h-10 items-center gap-1.5 px-4";

/** The activity on its way, in the shape of one group: its heading and its lines. No `status` of its own. */
function ActivityBlocks() {
  return (
    <div className="flex flex-col gap-1 py-2">
      <div className={GROUP_HEAD_CLASS}>
        <SkeletonLine className="w-12 text-xs font-medium" />
      </div>
      {["w-32", "w-40", "w-28"].map((width, i) => (
        <div key={i} className="flex min-h-10 items-center gap-2.5 px-4 py-1.5">
          <SkeletonLine className="w-4 text-sm" />
          <SkeletonLine className={cn("text-sm font-medium", width)} />
        </div>
      ))}
    </div>
  );
}

/** The summary while the conversation loads: its header lines, its activity, its folded lines. */
function SummarySkeleton() {
  return (
    <Waiting>
      <div className="divide-y">
        <div className="flex flex-col gap-0.5 px-4 py-3">
          <SkeletonLine className="w-2/3 text-sm font-semibold" />
          <SkeletonLine className="w-1/2 text-xs" />
        </div>
        <ActivityBlocks />
        {["w-28", "w-24", "w-16"].map((width, i) => (
          <div key={i} className="flex min-h-10 items-center gap-2 px-4 py-2">
            <span className="size-4 shrink-0" />
            <SkeletonLine className={cn("text-sm font-medium", width)} />
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
}: {
  session: NonNullable<ReturnType<typeof useSessionDetail>["data"]>;
}) {
  const { t, i18n } = useTranslation("chat");
  const { models, context } = conversationStats(session.messages);
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
          <CollapsibleTrigger className="hover:bg-muted/50 focus-visible:ring-ring flex min-h-10 w-full items-center justify-start gap-2 px-4 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset">
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "text-muted-foreground size-4 shrink-0 transition-transform",
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

/** The folding props of one section. */
function folding(sections: ReturnType<typeof useSummarySections>, id: SummarySectionId) {
  return { open: sections.isOpen(id), onOpenChange: (open: boolean) => sections.setOpen(id, open) };
}

/** One item of the activity on one line: its icon, its name, what it acted on, then its outcome. */
function ActivityLine({
  icon,
  label,
  detail,
  trailing,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  trailing?: ReactNode;
}) {
  return (
    <>
      <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 truncate font-medium">{label}</span>
        {detail ? (
          <span className="text-muted-foreground min-w-0 truncate text-xs">{detail}</span>
        ) : null}
      </span>
      {trailing ? <span className="flex shrink-0 items-center">{trailing}</span> : null}
    </>
  );
}

type ConversationRun = ReturnType<typeof useConversationRuns>["runs"][number];
type ConversationFile = ReturnType<typeof useConversationFiles>["files"][number];

/** A run on one line, leading to its page, as the Runs tab's rows do. */
function RunLine({ run, agentName }: { run: ConversationRun; agentName: string }) {
  const linkInSpace = useSpaceLink();
  const line = (
    <ActivityLine
      icon={<ActivityIcon />}
      label={agentName}
      detail={`#${run.runNumber}`}
      trailing={<RunStatusBadge status={run.status} unread={run.unread} compact />}
    />
  );
  return run.packageId ? (
    <Link
      to={linkInSpace(runDetailPath(run.packageId, run.id), run.spaceId)}
      state={{ runNumber: run.runNumber }}
      className={ROW_CLASS}
    >
      {line}
    </Link>
  ) : (
    <div className={ROW_CLASS}>{line}</div>
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
      className={ROW_CLASS}
      onClick={() => dispatch({ type: "show-tool-call", toolCallId: call.toolCallId })}
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

/**
 * A group of the activity: its name, its latest lines, and, when it holds more, "See all" to its
 * tab, with the count when the server gives one. `count` beside the name is for a group with no
 * tab of its own.
 */
function ActivityGroup({
  title,
  count,
  group,
  onSeeAll,
  children,
}: {
  title: string;
  count?: number;
  group?: Pick<SummaryGroup<unknown>, "more" | "total">;
  onSeeAll?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className="flex flex-col">
      <div className={GROUP_HEAD_CLASS}>
        <h4 className="text-muted-foreground text-xs font-medium">{title}</h4>
        {count !== undefined ? (
          <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
        ) : null}
        {group?.more && onSeeAll ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground desktop-pointer:h-6 ml-auto h-10 px-1.5 text-xs tabular-nums"
            onClick={onSeeAll}
          >
            {group.total === undefined
              ? t("context.summary.seeAll")
              : t("context.summary.seeAllCount", { count: group.total })}
          </Button>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/**
 * Everything the conversation did, in one view: what failed first (only when something did), the
 * integrations its calls reached, then its runs, its files and its actions (lookups apart), the
 * latest of each on one line. A group with nothing in it is left out; a group whose tab the reader
 * cannot see too. Its reads wait together, under one `status`.
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
  const { t } = useTranslation("chat");
  const latest = { limit: SUMMARY_ROWS };
  const runs = useConversationRuns(conversationId, active && showsRuns, latest);
  const failedRuns = useConversationRuns(conversationId, active && showsRuns, {
    ...latest,
    status: FAILED_RUN_STATUSES,
  });
  const files = useConversationFiles(conversationId, active && showsFiles, latest);
  const reads = [
    ...(showsRuns ? [runs.query, failedRuns.query] : []),
    ...(showsFiles ? [files.query] : []),
  ];
  const failure = reads.find((read) => read.error)?.error;

  if (failure) return <ErrorState error={failure} compact />;
  if (reads.some((read) => read.isPending)) {
    return (
      <Waiting>
        <ActivityBlocks />
      </Waiting>
    );
  }

  const model = summaryModel<ConversationRun, ConversationFile>({
    calls: tools.calls,
    ...(showsRuns
      ? {
          runs: { rows: runs.runs, total: runs.total },
          failedRuns: { rows: failedRuns.runs, total: failedRuns.total },
        }
      : {}),
    ...(showsFiles ? { files: { rows: files.files, hasMore: files.hasMore } } : {}),
  });
  const { attention } = model;

  return (
    <>
      {attention ? (
        <section className="flex flex-col py-2" aria-label={t("context.summary.attention")}>
          <ActivityGroup title={t("context.summary.attention")} count={attention.count}>
            {attention.runs.map((run) => (
              <RunLine key={run.id} run={run} agentName={failedRuns.agentName(run)} />
            ))}
            {attention.calls.map((call) => (
              <CallLine key={call.toolCallId} call={call} dispatch={dispatch} />
            ))}
          </ActivityGroup>
        </section>
      ) : null}
      <IntegrationsUsed tools={tools} />
      {!model.runs && !model.files && !model.actions ? (
        <p className="text-muted-foreground px-4 py-3 text-sm">{t("context.summary.noActivity")}</p>
      ) : (
        <section className="flex flex-col gap-1 py-2" aria-label={t("context.summary.activity")}>
          {model.runs ? (
            <ActivityGroup
              title={t("common:nav.runs")}
              group={model.runs}
              onSeeAll={seeAll("runs")}
            >
              {model.runs.rows.map((run) => (
                <RunLine key={run.id} run={run} agentName={runs.agentName(run)} />
              ))}
            </ActivityGroup>
          ) : null}
          {model.files ? (
            <ActivityGroup
              title={t("common:nav.files")}
              group={model.files}
              onSeeAll={seeAll("files")}
            >
              {model.files.rows.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  className={ROW_CLASS}
                  onClick={() =>
                    dispatch({
                      type: "show-file",
                      file: { id: file.id, name: file.name, spaceId: file.spaceId },
                      fromList: true,
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
              ))}
            </ActivityGroup>
          ) : null}
          {model.actions ? (
            <ActivityGroup
              title={t("context.summary.calls")}
              group={model.actions}
              onSeeAll={seeAll("tools")}
            >
              {model.actions.rows.map((call) => (
                <CallLine key={call.toolCallId} call={call} dispatch={dispatch} />
              ))}
            </ActivityGroup>
          ) : null}
        </section>
      )}
    </>
  );
}

/** The integrations the conversation's calls reached, on one line. Nothing when none did. */
function IntegrationsUsed({ tools }: { tools: ConversationTools }) {
  const { t } = useTranslation("chat");
  // As the platform presented each call: no read of its own.
  const integrations = tools.integrations.map((integration) => ({
    id: integration.id,
    name: integration.display_name ?? integration.id,
    icon: integration.icon ?? null,
  }));
  if (integrations.length === 0) return null;
  return (
    <section className="flex min-h-10 items-center gap-2 px-4 py-2">
      <h3 className="shrink-0 text-sm font-medium">{t("context.summary.integrations")}</h3>
      <span className="ml-auto flex min-w-0 items-center gap-2 pl-2">
        <span className="text-muted-foreground min-w-0 truncate text-xs">
          {integrations.map((integration) => integration.name).join(", ")}
        </span>
        <IntegrationLogoStack integrations={integrations} />
      </span>
    </section>
  );
}

/**
 * The conversation in one view: its title and gist, the integrations it reached, then all it did
 * (runs, files, actions) on one line each, each group leading to its tab; its models, the reader's
 * access and its details fold to one line each.
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
  if (query.error) return <ErrorState error={query.error} compact />;
  // Not read yet, or held while the panel is closed: never an error.
  if (query.data === undefined || tools === undefined) return <SummarySkeleton />;
  // The server holds no such conversation.
  if (query.data === null || tools === null) return <ErrorState compact />;

  const session = query.data;
  const title = session.title || t("context.summary.untitled");
  const { models } = conversationStats(session.messages);
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
        preview={models.map((model) => model.label).join(", ") || undefined}
        {...folding(sections, "usage")}
      >
        <ConversationUsage session={session} />
      </SummaryDisclosure>
      {access(session)}
      <SummaryDisclosure title={t("context.summary.details")} {...folding(sections, "details")}>
        <div className="flex flex-col gap-3">
          <FactGrid columns={1}>
            <Fact label={t("context.summary.created")}>
              <InfoDate iso={session.createdAt} />
            </Fact>
            <Fact label={t("context.summary.lastActivity")}>
              <InfoDate iso={session.updatedAt} />
            </Fact>
          </FactGrid>
          <ConversationId id={conversationId} />
        </div>
      </SummaryDisclosure>
    </div>
  );
}
