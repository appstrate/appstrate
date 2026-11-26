// SPDX-License-Identifier: Apache-2.0

import type { Dispatch, ReactNode } from "react";
import { useMemo } from "react";
import { ChevronRightIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNowTick } from "@appstrate/ui/use-now-tick";
import { useSessionDetail } from "@appstrate/module-chat/unread";
import { conversationStats } from "@appstrate/module-chat/conversation-stats";
import type { ConversationTools } from "@appstrate/module-chat/conversation-tools";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { CopyButton } from "@appstrate/ui/components/copy-button";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";
import { formatCompactTokens, formatTokenFigure } from "@appstrate/ui/context-window";
import { ErrorState } from "../../components/page-states";
import { IntegrationLogoStack } from "../../components/integration-logo-stack";
import { RunRow } from "../../components/run-row";
import { TextSkeleton, Waiting } from "../../components/loading-skeletons";
import { SkeletonLine } from "../../components/skeleton-line";
import { useIntegrationsById } from "../../hooks/use-integrations";
import { formatDateField, formatRelativeTime } from "../../lib/format-date";
import { ChatAccessSummary } from "./chat-access-summary";
import { ConversationFiles, ConversationRuns } from "./conversation-lists";
import type {
  ConversationSidebarAction,
  ConversationSidebarTab,
} from "./conversation-sidebar-state";
import { ToolCallRow } from "./conversation-tools-tab";
import { useConversationFiles, useConversationRuns } from "./use-conversation-lists";
import { spansSpaces, useConversationTools, useToolLabel } from "./use-conversation-tools";
import { useSummarySections, type SummarySectionId } from "./use-summary-sections";
import { useConversationTabs } from "./use-conversation-tabs";

/** The rows a preview section draws before its "See all". */
const PREVIEW_ROWS = 3;

/** A run status the summary asks the reader to look at. */
const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set(["failed", "timeout"]);

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

/** The summary while the conversation loads: its two header lines, then one line per section. */
function SummarySkeleton() {
  return (
    <Waiting className="divide-y">
      <div className="flex flex-col gap-1.5 px-4 py-3">
        <SkeletonLine className="w-2/3 text-sm font-semibold" />
        <SkeletonLine className="w-1/2 text-xs" />
      </div>
      {["w-16", "w-20", "w-16", "w-28", "w-24", "w-16"].map((width, i) => (
        <div key={i} className="flex min-h-11 items-center px-4 py-2">
          <SkeletonLine className={cn("text-sm", width)} />
        </div>
      ))}
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

/** A section always unfolded: what needs the reader is never behind a click. */
function SummarySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col py-2">
      <h3 className="flex min-h-8 items-center px-4 text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

/**
 * A folding section: one line naming it, how many it holds and its latest item, so the folded
 * summary reads at a glance; unfolded, its latest rows and the way to its tab.
 */
function SummaryDisclosure({
  title,
  count,
  preview,
  open,
  onOpenChange,
  onSeeAll,
  children,
}: {
  title: string;
  /** Absent while its read is on its way, or when it holds no list. */
  count?: number;
  /** The latest item, or the section's gist, on the folded line. */
  preview?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSeeAll?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <section>
        <h3>
          <CollapsibleTrigger className="hover:bg-muted/50 focus-visible:ring-ring flex min-h-11 w-full items-center justify-start gap-2 px-4 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset">
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "text-muted-foreground size-4 shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 text-sm font-medium">{title}</span>
            {count !== undefined ? (
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{count}</span>
            ) : null}
            {preview ? (
              <span className="text-muted-foreground ml-auto min-w-0 truncate pl-2 text-xs font-normal">
                {preview}
              </span>
            ) : null}
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent className="pb-2">
          {children}
          {onSeeAll && count !== undefined && count > PREVIEW_ROWS ? (
            <div className="px-4 pt-1">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onSeeAll}>
                {t("context.summary.seeAll")}
              </Button>
            </div>
          ) : null}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** One quiet line for a section with nothing in it: the tab still says so in full. */
function SectionEmpty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-4 pb-1 text-sm">{children}</p>;
}

type Sections = ReturnType<typeof useSummarySections>;

/** The folding props of one section. */
function folding(sections: Sections, id: SummarySectionId) {
  return { open: sections.isOpen(id), onOpenChange: (open: boolean) => sections.setOpen(id, open) };
}

/** What needs the reader: failed runs, failed or denied tool calls. Nothing when all went well. */
function NeedsAttention({
  conversationId,
  tools,
  dispatch,
}: {
  conversationId: string;
  tools: ConversationTools | null;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const { canRead, runs, agentName, agentById, spanning } = useConversationRuns(
    conversationId,
    true,
  );
  const failedRuns = canRead ? runs.filter((run) => FAILED_RUN_STATUSES.has(run.status)) : [];
  const failedCalls = (tools?.calls ?? []).filter(
    (call) => call.status === "error" || call.status === "denied",
  );
  if (failedRuns.length + failedCalls.length === 0) return null;
  const callsSpan = spansSpaces(failedCalls);
  return (
    <SummarySection title={t("context.summary.attention")}>
      <div className="divide-y">
        {failedRuns.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            agentName={agentName(run)}
            agent={run.packageId ? agentById.get(run.packageId) : undefined}
            dense
            spanning={spanning}
            className="px-3"
          />
        ))}
        {failedCalls.map((call) => (
          <ToolCallRow
            key={call.toolCallId}
            call={call}
            spanning={callsSpan}
            onSelect={() => dispatch({ type: "show-tool-call", toolCallId: call.toolCallId })}
          />
        ))}
      </div>
    </SummarySection>
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
    <section className="flex min-h-11 items-center gap-2 px-4 py-2">
      <h3 className="shrink-0 pl-6 text-sm font-medium">{t("context.summary.integrations")}</h3>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{ids.length}</span>
      <span className="ml-auto flex min-w-0 items-center gap-2 pl-2">
        <span className="text-muted-foreground min-w-0 truncate text-xs">
          {integrations.map((integration) => integration.name).join(", ")}
        </span>
        <IntegrationLogoStack integrations={integrations} />
      </span>
    </section>
  );
}

/** The latest runs, then the tab. */
function RunsPreview({
  conversationId,
  sections,
  onSeeAll,
}: {
  conversationId: string;
  sections: Sections;
  onSeeAll: () => void;
}) {
  const { t } = useTranslation("chat");
  const { query, runs, agentName } = useConversationRuns(conversationId, true);
  const latest = runs[0];
  return (
    <SummaryDisclosure
      title={t("common:nav.runs")}
      count={query.isLoading || query.error ? undefined : runs.length}
      preview={latest ? agentName(latest) : undefined}
      onSeeAll={onSeeAll}
      {...folding(sections, "runs")}
    >
      {query.isSuccess && runs.length === 0 ? (
        <SectionEmpty>{t("context.summary.noRun")}</SectionEmpty>
      ) : (
        <ConversationRuns conversationId={conversationId} active max={PREVIEW_ROWS} />
      )}
    </SummaryDisclosure>
  );
}

/** The latest files, then the tab. */
function FilesPreview({
  conversationId,
  sections,
  onSeeAll,
  dispatch,
}: {
  conversationId: string;
  sections: Sections;
  onSeeAll: () => void;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const { query, files } = useConversationFiles(conversationId, true);
  return (
    <SummaryDisclosure
      title={t("common:nav.files")}
      count={query.isLoading || query.error ? undefined : files.length}
      preview={files[0]?.name}
      onSeeAll={onSeeAll}
      {...folding(sections, "files")}
    >
      {query.isSuccess && files.length === 0 ? (
        <SectionEmpty>{t("context.summary.noFile")}</SectionEmpty>
      ) : (
        <ConversationFiles
          conversationId={conversationId}
          active
          max={PREVIEW_ROWS}
          onSelect={(file) => dispatch({ type: "show-file", file, fromList: true })}
        />
      )}
    </SummaryDisclosure>
  );
}

/** The latest actions (lookups apart), newest first, then the tab. */
function ToolsPreview({
  tools,
  sections,
  onSeeAll,
  dispatch,
}: {
  tools: ConversationTools | null;
  sections: Sections;
  onSeeAll: () => void;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const label = useToolLabel();
  const actions = (tools?.calls ?? []).filter((call) => !call.lookup);
  const latest = actions.slice(-PREVIEW_ROWS).reverse();
  const spanning = spansSpaces(latest);
  const newest = latest[0] ? label(latest[0]) : undefined;
  return (
    <SummaryDisclosure
      title={t("context.tabs.tools")}
      count={tools ? actions.length : undefined}
      preview={newest ? (newest.target ?? newest.title) : undefined}
      onSeeAll={onSeeAll}
      {...folding(sections, "tools")}
    >
      {!tools ? (
        <TextSkeleton className="p-4" />
      ) : latest.length === 0 ? (
        <SectionEmpty>{t("context.summary.noAction")}</SectionEmpty>
      ) : (
        <div className="divide-y">
          {latest.map((call) => (
            <ToolCallRow
              key={call.toolCallId}
              call={call}
              spanning={spanning}
              onSelect={() => dispatch({ type: "show-tool-call", toolCallId: call.toolCallId })}
            />
          ))}
        </div>
      )}
    </SummaryDisclosure>
  );
}

/**
 * The conversation in one view that reads without scrolling: its title and gist, what needs the
 * reader and the integrations it reached, always shown; its runs, files, actions, models, the
 * reader's access and its details, each on one folded line that unfolds in place (and leads to its
 * tab). A section whose tab the reader cannot see is left out with it.
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
      <div className="px-4 pt-1">
        <ChatAccessSummary conversation={conversation} />
      </div>
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
      <NeedsAttention conversationId={conversationId} tools={tools} dispatch={dispatch} />
      <IntegrationsUsed tools={tools} />
      {shows("runs") ? (
        <RunsPreview
          conversationId={conversationId}
          sections={sections}
          onSeeAll={seeAll("runs")}
        />
      ) : null}
      {shows("files") ? (
        <FilesPreview
          conversationId={conversationId}
          sections={sections}
          onSeeAll={seeAll("files")}
          dispatch={dispatch}
        />
      ) : null}
      <ToolsPreview
        tools={tools}
        sections={sections}
        onSeeAll={seeAll("tools")}
        dispatch={dispatch}
      />
      <SummaryDisclosure
        title={t("context.info.usageTitle")}
        preview={models.map((model) => model.label).join(", ") || undefined}
        {...folding(sections, "usage")}
      >
        <div className="px-4 pt-1">
          <ConversationUsage session={session} />
        </div>
      </SummaryDisclosure>
      {access}
      <SummaryDisclosure title={t("context.summary.details")} {...folding(sections, "details")}>
        <div className="flex flex-col gap-3 px-4 pt-1">
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
