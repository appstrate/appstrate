// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { LogEntryInspector, LogViewer } from "../log-viewer";
import type { JournalOverviewFilter } from "../log-viewer";
import type { ExecutionEntry } from "../log-utils";

export function RunExecutionView({
  run,
  logs,
  headerActions,
  notices,
  initialFilter,
}: {
  run: EnrichedRun;
  logs: ExecutionEntry[];
  headerActions?: ReactNode;
  notices?: ReactNode;
  initialFilter?: JournalOverviewFilter;
}) {
  const { t } = useTranslation("agents");
  const [selectedEntry, setSelectedEntry] = useState<ExecutionEntry | null>(null);

  return (
    <div
      className={cn(
        "grid min-w-0",
        selectedEntry && "lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]",
      )}
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
            selectedEntryId={selectedEntry?.id}
            onSelectEntry={setSelectedEntry}
            initialFocus={initialFilter}
          />
        </div>
      </section>
      {selectedEntry && (
        <aside className="border-border min-w-0 border-t lg:border-t-0 lg:border-l">
          <LogEntryInspector entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
        </aside>
      )}
    </div>
  );
}
