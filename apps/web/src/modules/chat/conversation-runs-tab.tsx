// SPDX-License-Identifier: Apache-2.0

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ActivityIcon, ChevronRightIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ACTIVE_RUN_STATUSES, type AgentListItem, type EnrichedRun } from "@appstrate/shared-types";
import { ACTIVITY_CONTENT_CLASS } from "@appstrate/module-chat/activity-line";
import { RunLine } from "@appstrate/module-chat/run-line";
import { runOutcomeText, visibleLogEntries } from "@appstrate/module-chat/run-events";
import { runReadAccess, useRunLogStream } from "@appstrate/module-chat/run-log-stream";
import type { RunStatus } from "@appstrate/core/run-status";
import { cn } from "@appstrate/ui/cn";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { RunStatusIcon } from "@appstrate/ui/components/run-status";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { EmptyState, ErrorState } from "../../components/page-states";
import { Waiting } from "../../components/loading-skeletons";
import { SkeletonLine } from "../../components/skeleton-line";
import { PackageIcon } from "../../components/package-icon";
import { IntegrationLogoStack } from "@appstrate/ui/components/integration-logo-stack";
import { RunDuration } from "../../components/run-duration";
import { SpaceTilesOf } from "../../components/space-name";
import { useRowSpaceGrants } from "../../hooks/use-permissions";
import { formatDateField } from "../../lib/format-date";
import { readShown, useConversationRuns } from "./use-conversation-lists";
import {
  openRunToRefetch,
  openRunUnlisted,
  type StoredSidebarFile,
} from "./conversation-sidebar-state";
import { useOpenItem } from "./use-open-item";
import { RunDetail } from "./conversation-run-detail";

const ACTIVE = ACTIVE_RUN_STATUSES as ReadonlySet<string>;

/**
 * One run on its two lines (`RunLine`), the disclosure of its detail. Open, the run is followed
 * over its own stream, and the list is read again once it ends so its result shows.
 */
function RunDisclosure({
  run,
  agentName,
  agent,
  spanning,
  canIn,
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
  canIn: ReturnType<typeof useRowSpaceGrants>;
  open: boolean;
  missing: boolean;
  onOpenChange: (open: boolean) => void;
  onShowInThread: () => void;
  onSelectFile: (file: StoredSidebarFile) => void;
  onSettled: () => unknown;
}) {
  const { t } = useTranslation(["chat", "agents"]);
  const subId = useId();
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
  const logs = useMemo(() => visibleLogEntries(stream.logs), [stream.logs]);
  const openItem = useOpenItem(open);
  // A remote run's process runs on its caller's host: the platform cannot signal it.
  const cancellable = active && run.runOrigin !== "remote" && canIn(run.spaceId, "runs:cancel");

  const start = run.started_at
    ? formatDateField(run.started_at)
    : t("dashboard.runPending", { ns: "agents" });
  const outcome = runOutcomeText(status, error, t);

  return (
    <Collapsible {...openItem} open={open} onOpenChange={onOpenChange}>
      {/* The trigger covers the line, behind it: the integrations' tooltip stays its own control
          rather than one nested in a button. */}
      <div className="relative isolate">
        <CollapsibleTrigger
          aria-label={
            run.runNumber != null
              ? t("runs.rowLabel", { ns: "agents", number: run.runNumber, agent: agentName })
              : agentName
          }
          aria-describedby={subId}
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
          sub={<span id={subId}>{`${start} · ${outcome}`}</span>}
        />
      </div>
      <CollapsibleContent className={ACTIVITY_CONTENT_CLASS}>
        <RunDetail
          run={run}
          status={status}
          error={error}
          logs={logs}
          named={spanning}
          cancellable={cancellable}
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
 * The runs a conversation launched, one line each, the one the panel holds open (`openRunId`)
 * showing its detail. A run opened from the thread that the polled list does not hold yet reads
 * the list again, once; still absent, a note says so.
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
  /** "See in the thread" found no line for the open run. */
  missing: boolean;
  onOpenChange: (run: EnrichedRun, open: boolean) => void;
  onShowInThread: (run: EnrichedRun) => void;
  onSelectFile: (file: StoredSidebarFile) => void;
}) {
  const { t } = useTranslation("chat");
  const canIn = useRowSpaceGrants();
  const { query, runs, agentName, agentById, spanning } = useConversationRuns(
    conversationId,
    active,
  );
  // Stable (React Query binds it once): a run's settling effect depends on it.
  const { refetch } = query;
  const read = readShown(query);
  // The answered list, the same array until the next answer.
  const listed = read === "ready" ? runs : undefined;
  const askedFor = useRef<string | null>(null);
  const [refetchedFor, setRefetchedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!listed) return;
    const runId = openRunToRefetch(openRunId, listed, askedFor.current);
    if (!runId) return;
    askedFor.current = runId;
    void refetch().then(() => setRefetchedFor(runId));
  }, [listed, openRunId, refetch]);
  const unlisted = openRunUnlisted(openRunId, listed, refetchedFor);

  if (!conversationId) {
    return <EmptyState message={t("context.unsaved")} icon={ActivityIcon} compact />;
  }
  if (read === "error") return <ErrorState error={query.error} compact />;
  // Pending covers a read not yet answered and one held while the panel is closed.
  if (read === "pending") return <RunLinesSkeleton />;
  const unlistedNote = unlisted ? (
    <Alert role="note" size="sm" className="m-3 w-auto">
      <AlertDescription>{t("context.runs.unlisted")}</AlertDescription>
    </Alert>
  ) : null;
  if (runs.length === 0) {
    return (
      <>
        {unlistedNote}
        <EmptyState message={t("context.runs.empty")} icon={ActivityIcon} compact />
      </>
    );
  }

  return (
    <div className="divide-y">
      {unlistedNote}
      {runs.map((run) => {
        const open = run.id === openRunId;
        return (
          <RunDisclosure
            key={run.id}
            run={run}
            agentName={agentName(run)}
            agent={run.packageId ? agentById.get(run.packageId) : undefined}
            spanning={spanning}
            canIn={canIn}
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
