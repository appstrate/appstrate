// SPDX-License-Identifier: Apache-2.0

import type { Dispatch, ReactNode } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNowTick } from "@appstrate/ui/use-now-tick";
import { useSessionDetail } from "@appstrate/module-chat/unread";
import { conversationStats } from "@appstrate/module-chat/conversation-stats";
import type { ConversationTools } from "@appstrate/module-chat/conversation-tools";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
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
import { spansSpaces, useConversationTools } from "./use-conversation-tools";
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

/** The header while the conversation loads, row for row; a date row is two lines (age, then date). */
function SummaryHeaderSkeleton() {
  const row = (key: string, width: string, lines = 1) => (
    <div key={key}>
      <SkeletonLine className="w-20 text-xs" />
      <div className="mt-1">
        {Array.from({ length: lines }, (_, i) => (
          <SkeletonLine key={i} className={i ? "w-16 text-xs" : cn("text-sm", width)} />
        ))}
      </div>
    </div>
  );
  return (
    <Waiting className="flex flex-col gap-4 p-4">
      <SkeletonLine className="w-2/3 text-base font-semibold" />
      <div className="flex flex-col gap-3">
        {row("created", "w-24", 2)}
        {row("activity", "w-24", 2)}
        {row("messages", "w-8")}
        {row("status", "w-16")}
      </div>
      <SkeletonLine className="w-3/4 text-xs" />
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
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t("context.info.usageTitle")}</h3>
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
    </section>
  );
}

/** A section of the summary: its title, how many it holds, and the tab that lists them all. */
function SummarySection({
  title,
  count,
  onSeeAll,
  children,
}: {
  title: string;
  /** Absent while its read is on its way. */
  count?: number;
  onSeeAll?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  return (
    <section className="flex flex-col py-2">
      <div className="flex min-h-8 items-center gap-2 px-4">
        <h3 className="text-sm font-medium">{title}</h3>
        {count !== undefined ? (
          <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
        ) : null}
        {onSeeAll && count !== undefined && count > PREVIEW_ROWS ? (
          <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={onSeeAll}>
            {t("context.summary.seeAll")}
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** One quiet line for a section with nothing in it: the tab still says so in full. */
function SectionEmpty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-4 pb-1 text-sm">{children}</p>;
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

/** The integrations the conversation's calls reached, as their logos. Nothing when none did. */
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
    <SummarySection title={t("context.summary.integrations")} count={ids.length}>
      <div className="flex items-center gap-3 px-4 pb-1">
        <IntegrationLogoStack integrations={integrations} />
        <span className="text-muted-foreground min-w-0 truncate text-sm">
          {integrations.map((integration) => integration.name).join(", ")}
        </span>
      </div>
    </SummarySection>
  );
}

/** The latest runs, then the tab. */
function RunsPreview({
  conversationId,
  onSeeAll,
}: {
  conversationId: string;
  onSeeAll: () => void;
}) {
  const { t } = useTranslation("chat");
  const { query, runs } = useConversationRuns(conversationId, true);
  return (
    <SummarySection
      title={t("common:nav.runs")}
      count={query.isLoading || query.error ? undefined : runs.length}
      onSeeAll={onSeeAll}
    >
      {query.isSuccess && runs.length === 0 ? (
        <SectionEmpty>{t("context.summary.noRun")}</SectionEmpty>
      ) : (
        <ConversationRuns conversationId={conversationId} active max={PREVIEW_ROWS} />
      )}
    </SummarySection>
  );
}

/** The latest files, then the tab. */
function FilesPreview({
  conversationId,
  onSeeAll,
  dispatch,
}: {
  conversationId: string;
  onSeeAll: () => void;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const { query, files } = useConversationFiles(conversationId, true);
  return (
    <SummarySection
      title={t("common:nav.files")}
      count={query.isLoading || query.error ? undefined : files.length}
      onSeeAll={onSeeAll}
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
    </SummarySection>
  );
}

/** The latest actions (lookups apart), newest first, then the tab. */
function ToolsPreview({
  tools,
  onSeeAll,
  dispatch,
}: {
  tools: ConversationTools | null;
  onSeeAll: () => void;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const actions = (tools?.calls ?? []).filter((call) => !call.lookup);
  const latest = actions.slice(-PREVIEW_ROWS).reverse();
  const spanning = spansSpaces(latest);
  return (
    <SummarySection
      title={t("context.tabs.tools")}
      count={tools ? actions.length : undefined}
      onSeeAll={onSeeAll}
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
    </SummarySection>
  );
}

/**
 * The conversation in one view: its facts, what needs the reader, the integrations it reached, its
 * latest runs, files and actions (each leading to its tab), its models and tokens, and the reader's
 * access. A section whose tab the reader cannot see is left out with it.
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
  const query = useSessionDetail(active ? conversationId : null);
  const { tools } = useConversationTools(conversationId, active);
  const { tabs } = useConversationTabs("summary");
  const shows = (tab: ConversationSidebarTab) => tabs.some(({ id }) => id === tab);
  const seeAll = (tab: ConversationSidebarTab) => () => dispatch({ type: "select-tab", tab });
  // The access judges the conversation's own scope: the same query as the header's.
  const conversation = !conversationId ? null : query.isLoading ? undefined : (query.data ?? null);

  if (!conversationId) {
    return (
      <div className="divide-y">
        <p className="text-muted-foreground p-4 text-sm">{t("context.unsaved")}</p>
        <div className="p-4">
          <ChatAccessSummary conversation={null} />
        </div>
      </div>
    );
  }
  if (query.isLoading) return <SummaryHeaderSkeleton />;
  if (query.error || !query.data) return <ErrorState error={query.error} compact />;

  const session = query.data;
  const facts: [string, ReactNode][] = [
    [t("context.info.created"), <InfoDate key="created" iso={session.createdAt} />],
    [t("context.info.lastActivity"), <InfoDate key="activity" iso={session.updatedAt} />],
    [t("context.info.messages"), String(session.messages.length)],
    [
      t("context.info.status"),
      session.generating ? t("context.info.generating") : t("context.info.idle"),
    ],
  ];

  return (
    <div className="divide-y">
      <div className="flex flex-col gap-4 p-4">
        <h3 className="text-base font-semibold break-words">
          {session.title || t("context.info.untitled")}
        </h3>
        <FactGrid columns={1}>
          {facts.map(([label, value]) => (
            <Fact key={label} label={label}>
              {value}
            </Fact>
          ))}
        </FactGrid>
        <ConversationId id={conversationId} />
      </div>
      <NeedsAttention conversationId={conversationId} tools={tools} dispatch={dispatch} />
      <IntegrationsUsed tools={tools} />
      {shows("runs") ? (
        <RunsPreview conversationId={conversationId} onSeeAll={seeAll("runs")} />
      ) : null}
      {shows("files") ? (
        <FilesPreview
          conversationId={conversationId}
          onSeeAll={seeAll("files")}
          dispatch={dispatch}
        />
      ) : null}
      <ToolsPreview tools={tools} onSeeAll={seeAll("tools")} dispatch={dispatch} />
      <div className="p-4">
        <ConversationUsage session={session} />
      </div>
      <div className="p-4">
        <ChatAccessSummary conversation={conversation} />
      </div>
    </div>
  );
}
