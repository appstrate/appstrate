// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type ReactNode } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { EnrichedRun } from "@appstrate/shared-types";
import { runFailureMessage, type VisibleLogEntry } from "@appstrate/module-chat/run-events";
import type { RunStatus } from "@appstrate/core/run-status";
import { Button } from "@appstrate/ui/components/button";
import { PendingButton } from "@/components/app-ui/pending-button";
import { ErrorState } from "../../components/page-states";
import { TextSkeleton } from "../../components/loading-skeletons";
import { RunCostReadout } from "../../components/run-cost-readout";
import { StructuredOutputBody } from "../../components/run-detail/run-results-view";
import type { components } from "../../api/client";
import { useFiles } from "../../hooks/use-files";
import { useCancelRun } from "../../hooks/use-mutations";
import { useRunPageHref } from "../../hooks/use-run-page-href";
import { producedRunFiles } from "../../lib/files";
import { readShown } from "./use-conversation-lists";
import { ConversationFileRow } from "./conversation-file-row";
import { ShowInThreadAction } from "./show-in-thread-action";
import type { StoredSidebarFile } from "./conversation-sidebar-state";

/** How close to its end, in pixels, the log counts as read to the bottom. */
const LOG_BOTTOM_SLACK = 8;

/** A section of an open run's detail: a small heading (under the tab's) over its content. */
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-xs font-medium">{title}</h3>
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

/** The run's log, following its last line while the reader is at its bottom. */
function RunLog({ logs }: { logs: VisibleLogEntry[] }) {
  const { t } = useTranslation("chat");
  const ref = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const list = ref.current;
    if (list && atBottom.current) list.scrollTop = list.scrollHeight;
  }, [logs.length]);
  return (
    <ol
      ref={ref}
      tabIndex={0}
      aria-label={t("context.runs.log")}
      onScroll={(event) => {
        const list = event.currentTarget;
        atBottom.current =
          list.scrollHeight - list.scrollTop - list.clientHeight <= LOG_BOTTOM_SLACK;
      }}
      className="bg-muted/40 focus-visible:ring-ring max-h-48 overflow-y-auto rounded-md p-2 font-mono text-xs focus-visible:ring-2 focus-visible:outline-none"
    >
      {logs.map((line) => (
        <li key={line.id} className="break-words">
          {line.text}
        </li>
      ))}
    </ol>
  );
}

/**
 * An open run's detail, each section only when it has something to say: its actions, its error,
 * its result, its files, its log (live while it runs), then its model and cost.
 */
export function RunDetail({
  run,
  status,
  error,
  logs,
  named,
  cancellable,
  missing,
  onShowInThread,
  onSelectFile,
}: {
  run: EnrichedRun;
  status: RunStatus;
  error: string | undefined;
  logs: VisibleLogEntry[];
  named: boolean;
  cancellable: boolean;
  missing: boolean;
  onShowInThread: () => void;
  onSelectFile: (file: StoredSidebarFile) => void;
}) {
  const { t } = useTranslation("chat");
  const href = useRunPageHref(run);
  const cancel = useCancelRun();
  const failure = runFailureMessage(status, error);
  // `output` is agent-declared, so the spec leaves it `unknown`: narrowed as the run page does.
  const result = run.result as components["schemas"]["Run"]["result"];
  const output = result?.output as Record<string, unknown> | undefined;
  const meta = run.model_label || run.cost != null;

  return (
    <div className="flex flex-col gap-4 px-4 pt-1 pb-4">
      <ShowInThreadAction
        missing={missing}
        missedLabel={t("context.runs.notInThread")}
        onShowInThread={onShowInThread}
      >
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
      </ShowInThreadAction>
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
          <RunLog logs={logs} />
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
