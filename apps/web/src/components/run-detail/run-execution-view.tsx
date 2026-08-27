// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import { LogViewer } from "../log-viewer";
import type { ExecutionEntry, RunTurnRow } from "../log-utils";
import { RunSnapshotInspector } from "./run-snapshot-inspector";

export function RunExecutionView({
  run,
  logs,
  turns,
  headerActions,
  notices,
}: {
  run: EnrichedRun;
  logs: ExecutionEntry[];
  turns: RunTurnRow[];
  headerActions?: ReactNode;
  notices?: ReactNode;
}) {
  const { t } = useTranslation("agents");

  return (
    <div
      className="grid min-w-0 lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]"
      data-run-journal-split
    >
      <section className="min-w-0">
        <div className="p-4 md:p-6">
          {notices && <div className="mb-4 space-y-3 empty:hidden [&>*]:mb-0">{notices}</div>}
          <LogViewer
            entries={logs}
            focusError={run.status === "failed"}
            variant="integrated"
            heading={t("run.executionStream")}
            headerActions={headerActions}
          />
        </div>
      </section>
      <aside className="border-border min-w-0 border-t lg:border-t-0 lg:border-l">
        <RunSnapshotInspector run={run} turns={turns} />
      </aside>
    </div>
  );
}
