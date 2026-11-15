// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import type { EnrichedRun } from "@appstrate/shared-types";
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

  // Laid on the page like every list tab: the viewer draws its toolbar, then its own card
  // holding the event list and, when a row is open, the inspector beside it.
  return (
    <LogViewer
      key={initialFilter ?? "all"}
      entries={logs}
      isLoading={logsLoading}
      focusError={run.status === "failed"}
      headerActions={headerActions}
      selectedEntryId={selectedId}
      onSelectEntry={setSelectedId}
      initialFocus={initialFilter}
      inspector={
        selectedEntry && (
          <LogEntryInspector entry={selectedEntry} onClose={() => setSelectedId(null)} />
        )
      }
    />
  );
}
