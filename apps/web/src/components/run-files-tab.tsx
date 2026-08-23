// SPDX-License-Identifier: Apache-2.0

/**
 * Run-detail "Fichiers" tab: the COMPLETE file view of a run — inputs (uploads
 * the run consumed) and outputs (files the agent produced), told apart by the
 * per-tile direction badge and filterable by purpose.
 *
 * The overlap with the Outcome pane, which lists the produced files again, is
 * deliberate: Outcome answers "what did this run produce?", this tab answers
 * "which files were involved at all?". Both read the SAME query (the run's
 * files in one page), so the second pane costs no extra request and the two can
 * never show a different list.
 *
 * No preview here, deliberately. The derived rule (#1177) still decides that a
 * run which produced exactly one file gets that file PRESENTED — but the pane
 * that presents it is Outcome, where the artefact leads the page. This tab is
 * the inventory: an inline preview above a list whose job is to be complete
 * pushed the list itself below the fold and answered a question the reader did
 * not come here to ask. Files open in the viewer on click, like any other row.
 *
 * The list is invalidated live from the run's SSE stream: `run-detail`
 * invalidates this query when a `file.published` log frame arrives, which is
 * also what refreshes it after a delete (useDeleteFile invalidates the same
 * query).
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFiles } from "../hooks/use-files";
import { FileListPanel, type PurposeFilter } from "./file-list-panel";

export function RunFilesTab({ runId }: { runId: string }) {
  const { t } = useTranslation("files");
  const { data, isLoading, error } = useFiles({ runId, limit: 100 });
  const [purpose, setPurpose] = useState<PurposeFilter>("all");

  const files = useMemo(() => {
    const all = data?.data ?? [];
    return purpose === "all" ? all : all.filter((d) => d.purpose === purpose);
  }, [data?.data, purpose]);

  return (
    <FileListPanel
      files={files}
      isLoading={isLoading}
      error={error}
      purpose={purpose}
      onPurposeChange={setPurpose}
      empty={{ message: t("run.empty"), hint: t("run.emptyHint"), compact: true }}
      runId={runId}
    />
  );
}
