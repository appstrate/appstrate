// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import type { EnrichedRun } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { LogEntryInspector, LogViewer } from "../log-viewer";
import type { JournalOverviewFilter } from "../log-viewer";
import type { ExecutionEntry } from "../log-utils";

export function RunExecutionView({
  run,
  logs,
  logsLoading = false,
  headerActions,
  initialFilter,
}: {
  run: EnrichedRun;
  logs: ExecutionEntry[];
  /** The journal is still being read: the viewer draws rows on their way, not "no log". */
  logsLoading?: boolean;
  headerActions?: ReactNode;
  initialFilter?: JournalOverviewFilter;
}) {
  // The id, not the entry: a live tool row settles in place, and the inspector
  // must show the row as it is now.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedEntry = selectedId ? (logs.find((entry) => entry.id === selectedId) ?? null) : null;

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
          <LogViewer
            key={initialFilter ?? "all"}
            entries={logs}
            isLoading={logsLoading}
            focusError={run.status === "failed"}
            headerActions={headerActions}
            selectedEntryId={selectedId}
            onSelectEntry={setSelectedId}
            initialFocus={initialFilter}
          />
        </div>
      </section>
      {selectedEntry && (
        <aside className="border-border min-w-0 border-t lg:border-t-0 lg:border-l">
          <LogEntryInspector entry={selectedEntry} onClose={() => setSelectedId(null)} />
        </aside>
      )}
    </div>
  );
}
