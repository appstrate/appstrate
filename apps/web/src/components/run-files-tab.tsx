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
 * The list is invalidated live from the run's SSE stream: `run-detail`
 * invalidates this query when a `file.published` log frame arrives, which is
 * also what refreshes it after a delete (useDeleteFile invalidates the same
 * query).
 *
 * When the run produced exactly ONE file, that file is featured above the list
 * with an inline preview — the derived rule (#1177) that replaced the agent's
 * `presentation: "primary"` declaration and the Deliverable tab it drove.
 * Several produced files are only listed: the page never picks one for the user.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFiles } from "../hooks/use-files";
import { featuredRunFile } from "../lib/files";
import { FileListPanel, type PurposeFilter } from "./file-list-panel";
import { RunFeaturedFile } from "./run-featured-file";

export function RunFilesTab({ runId }: { runId: string }) {
  const { t } = useTranslation("files");
  const { data, isLoading, error } = useFiles({ runId, limit: 100 });
  const [purpose, setPurpose] = useState<PurposeFilter>("all");

  const files = useMemo(() => {
    const all = data?.data ?? [];
    return purpose === "all" ? all : all.filter((d) => d.purpose === purpose);
  }, [data?.data, purpose]);

  // Computed off the FULL list, never the filtered view: the rule counts what
  // the run produced, and that count does not change because the user is
  // currently looking at the uploads filter.
  const featured = useMemo(() => featuredRunFile(data?.data ?? []), [data?.data]);

  return (
    <>
      {featured && purpose !== "user_upload" && (
        <RunFeaturedFile id={featured.id} name={featured.name} />
      )}
      <FileListPanel
        files={files}
        isLoading={isLoading}
        error={error}
        purpose={purpose}
        onPurposeChange={setPurpose}
        empty={{ message: t("run.empty"), hint: t("run.emptyHint"), compact: true }}
        runId={runId}
      />
    </>
  );
}
