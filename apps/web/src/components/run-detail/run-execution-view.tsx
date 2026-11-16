// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { ACTIVE_RUN_STATUSES, type EnrichedRun } from "@appstrate/shared-types";
import { LogEntryInspector, LogViewer } from "../log-viewer";
import type { JournalOverviewFilter } from "../log-viewer";
import type { ExecutionEntry } from "../log-utils";
import { useUrlModal } from "../../hooks/use-url-modal";
import { useJournalIntegrations } from "./journal-integrations";

/** The search parameter naming the open journal entry: a link or a reload reopens it. */
const ENTRY_PARAM = "entry";

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
  const entryParam = useUrlModal(ENTRY_PARAM);
  // The id, not the entry: a live tool row settles in place, and the inspector
  // must show the row as it is now. An id naming no entry opens nothing.
  const selectedEntry = entryParam.value
    ? (logs.find((entry) => entry.id === entryParam.value) ?? null)
    : null;
  // Read here once, for the list and the inspector alike.
  const integrations = useJournalIntegrations(logs);

  const selectEntry = (entryId: string | null) => {
    if (entryId === null) {
      entryParam.close();
      return;
    }
    // One click, one history entry: a selection reported twice before the URL re-renders
    // finds it already written.
    if (new URLSearchParams(window.location.search).get(ENTRY_PARAM) === entryId) return;
    entryParam.open(entryId);
  };

  // Laid on the page like every list tab: the viewer draws its toolbar, then its own card
  // holding the event list and, when a row is open, the inspector.
  return (
    <LogViewer
      key={initialFilter ?? "all"}
      entries={logs}
      integrations={integrations}
      isLoading={logsLoading}
      focusError={run.status === "failed"}
      live={(ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(run.status)}
      headerActions={headerActions}
      selectedEntryId={selectedEntry?.id ?? null}
      onSelectEntry={selectEntry}
      initialFocus={initialFilter}
      inspector={
        selectedEntry && (
          <LogEntryInspector
            entry={selectedEntry}
            integrations={integrations}
            onClose={() => selectEntry(null)}
          />
        )
      }
    />
  );
}
