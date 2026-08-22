// SPDX-License-Identifier: Apache-2.0

/**
 * Run-detail "Files" tab. Lists the files anchored to a run — inputs
 * (user uploads consumed by the run) and outputs (agent-produced files) —
 * filtered client-side by the same purpose tabs as the gallery (the run's
 * files are fetched in one page, so tab switches don't re-query). The list
 * is invalidated live from the run's SSE stream: `run-detail` invalidates this
 * query when a `file.published` log frame arrives, which is also what
 * refreshes it after a delete (useDeleteFile invalidates the same query).
 *
 * When the run produced exactly ONE file, that file is featured above the list
 * with an inline preview — the derived rule (#1177) that replaced the agent's
 * `presentation: "primary"` declaration and the Deliverable tab it drove.
 * Several produced files are only listed: the page never picks one for the user.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DownloadIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { useFile, useFileDownload, useFiles } from "../hooks/use-files";
import { featuredRunFile } from "../lib/files";
import { FileListPanel, type PurposeFilter } from "./file-list-panel";
import { FileViewer } from "./file-viewer";

/**
 * The featured file, previewed in place. Refetches the file on its own
 * (`useFile`) rather than reusing the list row: `preview_url` carries a
 * short-lived signed token that is minted per single-file GET.
 */
function FeaturedRunFile({ id, name }: { id: string; name: string }) {
  const { t } = useTranslation("files");
  const download = useFileDownload();
  const { data, isLoading, error } = useFile(id);
  const fileName = data?.name ?? name;
  const downloadButton = (
    <Button variant="outline" size="sm" onClick={() => void download(id, fileName)}>
      <DownloadIcon className="size-4" />
      {t("row.download")}
    </Button>
  );

  return (
    <section aria-label={t("run.featuredLabel")} className="mb-4 min-w-0">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
        <h2 className="truncate text-sm font-medium" title={fileName}>
          {fileName}
        </h2>
        {downloadButton}
      </div>
      <FileViewer
        fileId={id}
        file={data}
        isLoading={isLoading}
        error={error}
        unavailableAction={downloadButton}
        className="h-[max(24rem,calc(100vh-28rem))]"
      />
    </section>
  );
}

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
        <FeaturedRunFile id={featured.id} name={featured.name} />
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
