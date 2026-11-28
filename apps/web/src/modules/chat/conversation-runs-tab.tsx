// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type ReactNode } from "react";
import { ActivityIcon, ChevronRightIcon, ExternalLinkIcon, MessageSquareIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ACTIVE_RUN_STATUSES, type AgentListItem, type EnrichedRun } from "@appstrate/shared-types";
import { ACTIVITY_CONTENT_CLASS } from "@appstrate/module-chat/activity-line";
import { RunLine } from "@appstrate/module-chat/run-line";
import {
  runFailureMessage,
  runStatusLineKey,
  visibleLogEntries,
  type VisibleLogEntry,
} from "@appstrate/module-chat/run-events";
import { runReadAccess, useRunLogStream } from "@appstrate/module-chat/run-log-stream";
import type { RunStatus } from "@appstrate/core/run-status";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { RunStatusIcon } from "@appstrate/ui/components/run-status";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { PendingButton } from "@/components/app-ui/pending-button";
import { EmptyState, ErrorState } from "../../components/page-states";
import { TextSkeleton, Waiting } from "../../components/loading-skeletons";
import { SkeletonLine } from "../../components/skeleton-line";
import { PackageIcon } from "../../components/package-icon";
import { IntegrationLogoStack } from "../../components/integration-logo-stack";
import { RunDuration } from "../../components/run-duration";
import { RunCostReadout } from "../../components/run-cost-readout";
import { useRunPageHref } from "../../hooks/use-run-page-href";
import { SpaceTilesOf } from "../../components/space-name";
import { StructuredOutputBody } from "../../components/run-detail/run-results-view";
import type { components } from "../../api/client";
import { useFiles } from "../../hooks/use-files";
import { useCancelRun } from "../../hooks/use-mutations";
import { useRowSpaceGrants } from "../../hooks/use-permissions";
import { formatDateField } from "../../lib/format-date";
import { producedRunFiles } from "../../lib/files";
import { readShown, useConversationRuns } from "./use-conversation-lists";
import { ConversationFileRow } from "./conversation-file-row";
import type { StoredSidebarFile } from "./conversation-sidebar-state";

const ACTIVE = ACTIVE_RUN_STATUSES as ReadonlySet<string>;

/** A section of an open run's detail: a small heading over its content. */
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-muted-foreground text-xs font-medium">{title}</h4>
      {children}
    </section>
  );
}

/** The run's produced files, read across spaces while its line is open. */
function RunFiles({
  run,
  named,
  onSelectFile,
}: {
  run: EnrichedRun;
  named: boolean;
  onSelectFile: (file: StoredSidebarFile) => void;
}) {
  const { t } = useTranslation("chat");
  const query = useFiles({ spanning: true, runId: run.id, limit: 100 });
  const read = readShown(query);
  if (read === "error") return <ErrorState error={query.error} compact />;
  // A read the reader may not make never starts: nothing waits for it.
  if (read === "pending") {
    return query.isFetching && run.file_counts.output > 0 ? <TextSkeleton lines={1} /> : null;
  }
  // A file chained in from an earlier run sits in the run's container too: only its own outputs.
  const files = producedRunFiles(query.data?.data ?? [], run.id);
  if (files.length === 0) return null;
  return (
    <DetailSection title={t("context.runs.files")}>
      <div className="-mx-4 divide-y">
        {files.map((file) => (
          <ConversationFileRow key={file.id} file={file} named={named} onSelect={onSelectFile} />
        ))}
      </div>
    </DetailSection>
  );
}

/**
 * An open run's detail, each section only when it has something to say: its actions, its error,
 * its result, its files, its log (live while it runs), then its model and cost.
 */
function RunDetail({
  run,
  status,
  error,
  logs,
  named,
  missing,
  onShowInThread,
  onSelectFile,
}: {
  run: EnrichedRun;
  status: RunStatus;
  error: string | undefined;
  logs: VisibleLogEntry[];
  named: boolean;
  missing: boolean;
  onShowInThread: () => void;
  onSelectFile: (file: StoredSidebarFile) => void;
}) {
  const { t } = useTranslation("chat");
  const href = useRunPageHref(run);
  const canIn = useRowSpaceGrants();
  const cancel = useCancelRun();
  // A remote run's process runs on its caller's host: the platform cannot signal it.
  const cancellable =
    ACTIVE.has(status) && run.runOrigin !== "remote" && canIn(run.spaceId, "runs:cancel");
  const failure = runFailureMessage(status, error);
  // `output` is agent-declared, so the spec leaves it `unknown`: narrowed as the run page does.
  const result = run.result as components["schemas"]["Run"]["result"];
  const output = result?.output as Record<string, unknown> | undefined;
  const logRef = useRef<HTMLOListElement>(null);
  // The log follows its last line while it runs, as a run page's journal does.
  useEffect(() => {
    const list = logRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [logs.length]);
  const meta = run.model_label || run.cost != null;

  return (
    <div className="flex flex-col gap-4 px-4 pt-1 pb-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="desktop-pointer:h-9 h-10"
            onClick={onShowInThread}
          >
            <MessageSquareIcon />
            {t("context.showInThread")}
          </Button>
          {href ? (
            <Button
              variant="outline"
              size="sm"
              className="desktop-pointer:h-9 h-10"
              render={<Link to={href} state={{ runNumber: run.runNumber }} />}
            >
              <ExternalLinkIcon />
              {t("context.runs.openPage")}
            </Button>
          ) : null}
          {cancellable ? (
            <PendingButton
              variant="outline"
              size="sm"
              className="desktop-pointer:h-9 h-10"
              pending={cancel.isPending}
              onClick={() => cancel.mutate({ id: run.id, spaceId: run.spaceId })}
            >
              {t("context.runs.cancel")}
            </PendingButton>
          ) : null}
        </div>
        {missing ? (
          <p className="text-muted-foreground text-xs">{t("context.runs.notInThread")}</p>
        ) : null}
      </div>
      {failure ? (
        <DetailSection title={t("context.runs.error")}>
          <p className="text-sm break-words">{failure}</p>
        </DetailSection>
      ) : null}
      {output && Object.keys(output).length > 0 ? (
        <DetailSection title={t("context.runs.result")}>
          <StructuredOutputBody output={output} schema={undefined} />
        </DetailSection>
      ) : null}
      <RunFiles run={run} named={named} onSelectFile={onSelectFile} />
      {logs.length > 0 ? (
        <DetailSection title={t("context.runs.log")}>
          <ol
            ref={logRef}
            className="bg-muted/40 max-h-48 overflow-y-auto rounded-md p-2 font-mono text-xs"
          >
            {logs.map((line) => (
              <li key={line.id} className="break-words">
                {line.text}
              </li>
            ))}
          </ol>
        </DetailSection>
      ) : null}
      {meta ? (
        <p className="text-muted-foreground flex flex-wrap gap-x-1.5 text-xs">
          {run.model_label ? <span>{run.model_label}</span> : null}
          {run.model_label && run.cost != null ? <span aria-hidden>·</span> : null}
          {run.cost != null ? (
            <RunCostReadout cost={run.cost} pricingStatus={run.cost_pricing_status} />
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One run as the thread's card draws it (`RunLine`): the agent's tile with the run's state on its
 * corner, its name and number, its integrations, its space when the list spans several, its
 * duration; under them its start and outcome. The line is the disclosure of its detail; open, the
 * run is followed live over its own stream (`useRunLogStream`), which the line's state follows
 * too, and the list is read again once it ends so its result shows.
 */
function RunDisclosure({
  run,
  agentName,
  agent,
  spanning,
  open,
  missing,
  onOpenChange,
  onShowInThread,
  onSelectFile,
  onSettled,
}: {
  run: EnrichedRun;
  agentName: string;
  agent: AgentListItem | undefined;
  spanning: boolean;
  open: boolean;
  missing: boolean;
  onOpenChange: (open: boolean) => void;
  onShowInThread: () => void;
  onSelectFile: (file: StoredSidebarFile) => void;
  onSettled: () => unknown;
}) {
  const { t } = useTranslation(["chat", "agents"]);
  const canIn = useRowSpaceGrants();
  const stream = useRunLogStream(
    open ? run.id : undefined,
    run.status,
    run.packageId ?? undefined,
    run.spaceId,
    // The files come from the panel's own read (`RunFiles`), with their size and date.
    { ...runReadAccess((permission) => canIn(run.spaceId, permission)), files: false },
  );
  const status: RunStatus = stream.status ?? run.status;
  const active = ACTIVE.has(status);
  const error = stream.error ?? run.error ?? undefined;
  // The list row was read while the run went: read it again once it ends, for its result.
  const settledLate = !active && ACTIVE.has(run.status);
  useEffect(() => {
    if (settledLate) onSettled();
  }, [settledLate, onSettled]);
  const logs = visibleLogEntries(stream.logs);
  const ref = useRef<HTMLDivElement>(null);
  // Opened from the thread's card or by a reveal that missed, the line comes into sight.
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const start = run.started_at
    ? formatDateField(run.started_at)
    : t("dashboard.runPending", { ns: "agents" });
  const outcome = active
    ? t(status === "running" ? "run.running" : "run.starting")
    : (runFailureMessage(status, error) ?? t(runStatusLineKey(status)));

  return (
    <Collapsible ref={ref} open={open} onOpenChange={onOpenChange}>
      {/* The trigger covers the line, behind it: the integrations' tooltip stays its own control
          rather than one nested in a button. */}
      <div className="relative isolate">
        <CollapsibleTrigger
          aria-label={run.runNumber != null ? `${agentName} #${run.runNumber}` : agentName}
          className="hover:bg-muted/50 focus-visible:ring-ring absolute inset-0 z-0 transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
        />
        <RunLine
          className="pointer-events-none relative z-10 min-h-14 px-4 py-2.5"
          tile={
            <PackageIcon
              type="agent"
              id={run.packageId ?? agentName}
              name={agentName}
              icon={agent?.icon}
              color={agent?.color}
              className="size-8 rounded-lg"
            />
          }
          badge={
            <span className="relative flex">
              <RunStatusIcon status={status} />
              {run.unread ? (
                <span className="bg-destructive absolute -top-1 -right-1 size-1.5 rounded-full" />
              ) : null}
            </span>
          }
          name={
            <>
              {agentName}
              {run.runNumber != null ? (
                <span className="text-muted-foreground font-normal"> #{run.runNumber}</span>
              ) : null}
            </>
          }
          trailing={
            <>
              {agent ? (
                <span className="pointer-events-auto flex">
                  <IntegrationLogoStack integrations={agent.integrations} />
                </span>
              ) : null}
              {spanning ? (
                <span className="text-muted-foreground flex text-xs">
                  <SpaceTilesOf spaceIds={[run.spaceId]} tilesOnly />
                </span>
              ) : null}
              <RunDuration
                status={status}
                startedAt={stream.startedAt ?? run.started_at}
                duration={stream.duration ?? run.duration}
              />
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "text-muted-foreground duration-fast ease-surface size-3.5 transition-transform",
                  open && "rotate-90",
                )}
              />
            </>
          }
          sub={<span>{`${start} · ${outcome}`}</span>}
        />
      </div>
      <CollapsibleContent className={ACTIVITY_CONTENT_CLASS}>
        <RunDetail
          run={run}
          status={status}
          error={error}
          logs={logs}
          named={spanning}
          missing={missing}
          onShowInThread={onShowInThread}
          onSelectFile={onSelectFile}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The Runs tab while its runs are read: lines with their tile and two lines of text. */
function RunLinesSkeleton() {
  return (
    <Waiting className="divide-y">
      {["w-32", "w-40", "w-28"].map((width) => (
        <div key={width} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <SkeletonLine className={cn("text-sm", width)} />
            <SkeletonLine className="w-24 text-xs" />
          </div>
        </div>
      ))}
    </Waiting>
  );
}

/**
 * The runs a conversation launched, one line each (`RunDisclosure`), the one the panel holds open
 * (`openRunId`) showing its detail under its line.
 */
export function ConversationRuns({
  conversationId,
  active,
  openRunId,
  missing,
  onOpenChange,
  onShowInThread,
  onSelectFile,
}: {
  conversationId: string | null;
  active: boolean;
  openRunId: string | null;
  /** "See in the thread" found no card for the open run. */
  missing: boolean;
  onOpenChange: (run: EnrichedRun, open: boolean) => void;
  onShowInThread: (run: EnrichedRun) => void;
  onSelectFile: (file: StoredSidebarFile) => void;
}) {
  const { t } = useTranslation("chat");
  const { query, runs, agentName, agentById, spanning } = useConversationRuns(
    conversationId,
    active,
  );
  // Stable (React Query binds it once): a run's settling effect depends on it.
  const { refetch } = query;

  if (!conversationId) {
    return <EmptyState message={t("context.unsaved")} icon={ActivityIcon} compact />;
  }
  const read = readShown(query);
  if (read === "error") return <ErrorState error={query.error} compact />;
  // Pending covers a read not yet answered and one held while the panel is closed.
  if (read === "pending") return <RunLinesSkeleton />;
  if (runs.length === 0) {
    return <EmptyState message={t("context.runs.empty")} icon={ActivityIcon} compact />;
  }

  return (
    <div className="divide-y">
      {runs.map((run) => {
        const open = run.id === openRunId;
        return (
          <RunDisclosure
            key={run.id}
            run={run}
            agentName={agentName(run)}
            agent={run.packageId ? agentById.get(run.packageId) : undefined}
            spanning={spanning}
            open={open}
            missing={open && missing}
            onOpenChange={(next) => onOpenChange(run, next)}
            onShowInThread={() => onShowInThread(run)}
            onSelectFile={onSelectFile}
            onSettled={refetch}
          />
        );
      })}
    </div>
  );
}
