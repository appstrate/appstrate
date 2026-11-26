// SPDX-License-Identifier: Apache-2.0

import type { Dispatch, ReactNode } from "react";
import { useMemo } from "react";
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
import { useIntegrationsById } from "../../hooks/use-integrations";
import { formatBytes } from "../../lib/format-bytes";
import { runDetailPath } from "../../lib/package-paths";
import { formatDateField, formatRelativeTime } from "../../lib/format-date";
import { ChatAccessSummary } from "./chat-access-summary";
import type {
  ConversationSidebarAction,
  ConversationSidebarTab,
} from "./conversation-sidebar-state";
import { ToolCallIcon } from "./conversation-tools-tab";
import { useConversationFiles, useConversationRuns } from "./use-conversation-lists";
import { useConversationTools, useToolLabel } from "./use-conversation-tools";
import { useSummarySections, type SummarySectionId } from "./use-summary-sections";
import { useConversationTabs } from "./use-conversation-tabs";

/** The lines an activity group draws before its "See all". */
const ACTIVITY_ROWS = 5;

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
        aria-label={`${t("common:btn.copy")} (${t("chat:context.info.id")})`}
      />
    </div>
  );
}

/** The summary while the conversation loads: its two header lines, its activity, its folded lines. */
function SummarySkeleton() {
  return (
    <div className="divide-y">
      <Waiting className="flex flex-col gap-1.5 px-4 py-3">
        <SkeletonLine className="w-2/3 text-sm font-semibold" />
        <SkeletonLine className="w-1/2 text-xs" />
      </Waiting>
      <ActivitySkeleton />
      <Waiting className="divide-y">
        {["w-28", "w-24", "w-16"].map((width, i) => (
          <div key={i} className="flex min-h-10 items-center px-4 py-2">
            <SkeletonLine className={cn("text-sm", width)} />
          </div>
        ))}
      </Waiting>
    </div>
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
        <p className="text-muted-foreground text-sm">{t("context.info.noTurn")}</p>
      ) : (
        <>
          <FactGrid columns={1}>
            {context ? (
              <Fact label={t("context.info.currentContext")}>
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
              <Fact label={t("context.info.models", { count: models.length })}>
                <ul className="flex flex-col gap-0.5">
                  {models.map((model) => (
                    <li key={model.modelId}>
                      {model.failed > 0
                        ? t("context.info.modelTurnsFailed", {
                            model: model.label,
                            count: model.turns,
                            failed: model.failed,
                          })
                        : t("context.info.modelTurns", { model: model.label, count: model.turns })}
                    </li>
                  ))}
                </ul>
              </Fact>
            ) : null}
            {metered ? (
              <Fact label={t("context.info.tokens")}>
                {t("context.info.tokensReadGenerated", {
                  read: formatCompactTokens(read, i18n.language),
                  generated: formatCompactTokens(generated, i18n.language),
                })}
              </Fact>
            ) : null}
          </FactGrid>
          {metered ? (
            <p className="text-muted-foreground text-xs">{t("context.info.tokensScope")}</p>
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

const ROW_CLASS =
  "hover:bg-muted/50 flex min-h-9 w-full items-center gap-2.5 px-4 py-1.5 text-left text-sm transition-colors";

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

/** A group of the activity: its name and count, its latest lines, and its tab past them. */
function ActivityGroup({
  title,
  count,
  onSeeAll,
  children,
}: {
  title: string;
  count: number;
  onSeeAll: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className="flex flex-col">
      <div className="flex min-h-7 items-center gap-1.5 px-4 pt-1">
        <h4 className="text-muted-foreground text-xs font-medium">{title}</h4>
        <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
        {count > ACTIVITY_ROWS ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground ml-auto h-6 px-1.5 text-xs"
            onClick={onSeeAll}
          >
            {t("context.summary.seeAll")}
          </Button>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/**
 * Everything the conversation did, in one view: its runs, its files and its actions (lookups
 * apart), the latest of each on one line, a failure in its own tone. A group with nothing in it is
 * left out; a group whose tab the reader cannot see too.
 */
function ConversationActivity({
  conversationId,
  tools,
  showsRuns,
  showsFiles,
  seeAll,
  dispatch,
}: {
  conversationId: string;
  tools: ConversationTools | null;
  showsRuns: boolean;
  showsFiles: boolean;
  seeAll: (tab: ConversationSidebarTab) => () => void;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const linkInSpace = useSpaceLink();
  const label = useToolLabel();
  const runs = useConversationRuns(conversationId, showsRuns);
  const files = useConversationFiles(conversationId, showsFiles);
  const actions = (tools?.calls ?? []).filter((call) => !call.lookup);
  const runRows = showsRuns ? runs.runs : [];
  const fileRows = showsFiles ? files.files : [];
  const loading =
    !tools || (showsRuns && runs.query.isLoading) || (showsFiles && files.query.isLoading);

  if (loading) return <ActivitySkeleton />;
  if (runRows.length + fileRows.length + actions.length === 0) {
    return (
      <p className="text-muted-foreground px-4 py-3 text-sm">{t("context.summary.noActivity")}</p>
    );
  }

  return (
    <section className="flex flex-col gap-1 py-2" aria-label={t("context.summary.activity")}>
      {runRows.length > 0 ? (
        <ActivityGroup
          title={t("common:nav.runs")}
          count={runRows.length}
          onSeeAll={seeAll("runs")}
        >
          {runRows.slice(0, ACTIVITY_ROWS).map((run) => {
            const line = (
              <ActivityLine
                icon={<ActivityIcon />}
                label={runs.agentName(run)}
                detail={`#${run.runNumber}`}
                trailing={<RunStatusBadge status={run.status} unread={run.unread} compact />}
              />
            );
            return run.packageId ? (
              <Link
                key={run.id}
                to={linkInSpace(runDetailPath(run.packageId, run.id), run.spaceId)}
                state={{ runNumber: run.runNumber }}
                className={ROW_CLASS}
              >
                {line}
              </Link>
            ) : (
              <div key={run.id} className={ROW_CLASS}>
                {line}
              </div>
            );
          })}
        </ActivityGroup>
      ) : null}
      {fileRows.length > 0 ? (
        <ActivityGroup
          title={t("common:nav.files")}
          count={fileRows.length}
          onSeeAll={seeAll("files")}
        >
          {fileRows.slice(0, ACTIVITY_ROWS).map((file) => (
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
      {actions.length > 0 ? (
        <ActivityGroup
          title={t("context.summary.calls")}
          count={actions.length}
          onSeeAll={seeAll("tools")}
        >
          {actions
            .slice(-ACTIVITY_ROWS)
            .reverse()
            .map((call) => {
              const { title, target } = label(call);
              return (
                <button
                  key={call.toolCallId}
                  type="button"
                  className={ROW_CLASS}
                  onClick={() => dispatch({ type: "show-tool-call", toolCallId: call.toolCallId })}
                >
                  <ActivityLine
                    icon={<ToolCallIcon call={call} />}
                    label={title}
                    detail={target}
                    trailing={
                      call.status === "success" ? null : (
                        <span className={cn("text-xs", CALL_TONE[call.status])}>
                          {t(`context.tools.status.${call.status}`)}
                        </span>
                      )
                    }
                  />
                </button>
              );
            })}
        </ActivityGroup>
      ) : null}
    </section>
  );
}

const CALL_TONE: Record<ConversationToolCall["status"], string> = {
  running: "text-muted-foreground",
  success: "text-muted-foreground",
  error: "text-destructive",
  denied: "text-warning",
};

/** The activity while it loads: a group heading and its lines. */
function ActivitySkeleton() {
  return (
    <Waiting className="flex flex-col gap-1 py-2">
      <div className="flex min-h-7 items-center px-4 pt-1">
        <SkeletonLine className="w-12 text-xs" />
      </div>
      {["w-32", "w-40", "w-28"].map((width, i) => (
        <div key={i} className="flex min-h-9 items-center gap-2.5 px-4 py-1.5">
          <SkeletonLine className="w-4 text-sm" />
          <SkeletonLine className={cn("text-sm", width)} />
        </div>
      ))}
    </Waiting>
  );
}

/** The integrations the conversation's calls reached, on one line. Nothing when none did. */
function IntegrationsUsed({ tools }: { tools: ConversationTools | null }) {
  const { t } = useTranslation("chat");
  const ids = useMemo(() => (tools?.integrations ?? []).map((use) => use.packageId), [tools]);
  // One integration not readable here (another space's, no `integrations:read`) keeps its id.
  const { data } = useIntegrationsById(ids);
  if (ids.length === 0) return null;
  const rows = new Map((data ?? []).map((row) => [row.id, row] as const));
  const integrations = ids.map((id) => {
    const row = rows.get(id);
    return {
      id,
      name: row?.manifest.display_name ?? id,
      icon: row?.manifest.icon ?? null,
      required: false,
      authenticated: true,
    };
  });
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
  const query = useSessionDetail(active ? conversationId : null);
  const { tools } = useConversationTools(conversationId, active);
  const { tabs } = useConversationTabs("summary");
  const shows = (tab: ConversationSidebarTab) => tabs.some(({ id }) => id === tab);
  const seeAll = (tab: ConversationSidebarTab) => () => dispatch({ type: "select-tab", tab });
  // The access judges the conversation's own scope: the same query as the header's.
  const conversation = !conversationId ? null : query.isLoading ? undefined : (query.data ?? null);
  const access = (
    <SummaryDisclosure title={t("context.info.access")} {...folding(sections, "access")}>
      <ChatAccessSummary conversation={conversation} />
    </SummaryDisclosure>
  );

  if (!conversationId) {
    return (
      <div className="divide-y">
        <p className="text-muted-foreground p-4 text-sm">{t("context.unsaved")}</p>
        {access}
      </div>
    );
  }
  if (query.isLoading) return <SummarySkeleton />;
  if (query.error || !query.data) return <ErrorState error={query.error} compact />;

  const session = query.data;
  const title = session.title || t("context.info.untitled");
  const { models } = conversationStats(session.messages);
  const gist = [
    t("context.summary.messages", { count: session.messages.length }),
    session.generating ? t("context.info.generating") : null,
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
      <IntegrationsUsed tools={tools} />
      <ConversationActivity
        conversationId={conversationId}
        tools={tools}
        showsRuns={shows("runs")}
        showsFiles={shows("files")}
        seeAll={seeAll}
        dispatch={dispatch}
      />
      <SummaryDisclosure
        title={t("context.info.usageTitle")}
        preview={models.map((model) => model.label).join(", ") || undefined}
        {...folding(sections, "usage")}
      >
        <ConversationUsage session={session} />
      </SummaryDisclosure>
      {access}
      <SummaryDisclosure title={t("context.summary.details")} {...folding(sections, "details")}>
        <div className="flex flex-col gap-3">
          <FactGrid columns={1}>
            <Fact label={t("context.info.created")}>
              <InfoDate iso={session.createdAt} />
            </Fact>
            <Fact label={t("context.info.lastActivity")}>
              <InfoDate iso={session.updatedAt} />
            </Fact>
          </FactGrid>
          <ConversationId id={conversationId} />
        </div>
      </SummaryDisclosure>
    </div>
  );
}
