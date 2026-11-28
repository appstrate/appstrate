// SPDX-License-Identifier: Apache-2.0

import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNowTick } from "@appstrate/ui/use-now-tick";
import { useSessionDetail } from "@appstrate/module-chat/unread";
import {
  conversationStats,
  type ConversationStats,
} from "@appstrate/module-chat/conversation-stats";
import { cn } from "@appstrate/ui/cn";
import { CopyButton } from "@appstrate/ui/components/copy-button";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { formatCompactTokens, formatTokenFigure } from "@appstrate/ui/context-window";
import { ErrorState } from "../../components/page-states";
import { Waiting } from "../../components/loading-skeletons";
import { SkeletonLine } from "../../components/skeleton-line";
import { formatDateField, formatRelativeTime } from "../../lib/format-date";
import { ChatAccessSummary } from "./chat-access-summary";

/** A titled section of the Info tab, headed as the summary's activity groups are. */
function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="flex flex-col gap-2 px-4 py-3" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-muted-foreground text-xs font-medium">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** A section heading on its way, over its lines (or the access summary's own box). */
function SectionSkeleton({ lines }: { lines: string[] | null }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <SkeletonLine className="w-24 text-xs font-medium" />
      {lines ? (
        lines.map((width) => <SkeletonLine key={width} className={cn("text-sm", width)} />)
      ) : (
        <Skeleton className="h-24 w-full rounded-md" />
      )}
    </div>
  );
}

/** The Info tab while the conversation loads: models and tokens, access, details. */
function InfoSkeleton() {
  return (
    <Waiting>
      <div className="divide-y">
        <SectionSkeleton lines={["w-1/3", "w-2/3", "w-1/2"]} />
        <SectionSkeleton lines={null} />
        <SectionSkeleton lines={["w-1/3", "w-2/3"]} />
      </div>
    </Waiting>
  );
}

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

  if (models.length === 0 && !context && !metered) {
    return <p className="text-muted-foreground text-sm">{t("context.summary.noTurn")}</p>;
  }
  return (
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
                    : t("context.summary.modelTurns", { model: model.label, count: model.turns })}
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
  );
}

/**
 * The conversation's facts, each section open: its models and tokens, the reader's access (which
 * judges a conversation not stored yet too, alone then) and its details.
 */
export function ConversationInfo({
  conversationId,
  active,
}: {
  conversationId: string | null;
  active: boolean;
}) {
  const { t } = useTranslation("chat");
  const query = useSessionDetail(conversationId, { enabled: active });

  if (!conversationId) {
    return (
      <InfoSection title={t("context.summary.access")}>
        <ChatAccessSummary conversation={null} />
      </InfoSection>
    );
  }
  // A refetch that fails keeps the conversation already read.
  if (query.data === undefined && query.error) return <ErrorState error={query.error} compact />;
  // Not read yet, or held while the panel is closed: never an error.
  if (query.data === undefined) return <InfoSkeleton />;
  // The server holds no such conversation.
  if (query.data === null) return <ErrorState compact />;

  const session = query.data;
  return (
    <div className="divide-y">
      <InfoSection title={t("context.summary.usageTitle")}>
        <ConversationUsage session={session} stats={conversationStats(session.messages)} />
      </InfoSection>
      {/* The access judges the conversation's own scope. */}
      <InfoSection title={t("context.summary.access")}>
        <ChatAccessSummary conversation={session} />
      </InfoSection>
      <InfoSection title={t("context.summary.details")}>
        <FactGrid columns={1}>
          <Fact label={t("context.summary.created")}>
            <InfoDate iso={session.createdAt} />
          </Fact>
        </FactGrid>
        <ConversationId id={conversationId} />
      </InfoSection>
    </div>
  );
}
