// SPDX-License-Identifier: Apache-2.0

/**
 * The one file a run produced, previewed in place — the visible half of the
 * derived presentation rule (#1177): a run that produced exactly one file
 * presents it, several are only listed and the user picks.
 *
 * Rendered by the Outcome pane ONLY, and it leads that pane: the artefact is
 * what the run is for, so it sits above the `output` JSON and outside any card.
 * The Fichiers tab deliberately does NOT render it. That tab is the complete
 * inventory — inputs and outputs both — and an inline preview above it pushed
 * the list below the fold to answer a question the reader did not come there to
 * ask. Presenting the file is Outcome's job; listing every file is Fichiers'.
 *
 * Its own module because the viewer and {@link RunFeaturedFilePlaceholder} must
 * keep the same footprint (see `VIEWER_HEIGHT`), and because the pane decides
 * WHICH of the two to show before the file list has answered.
 *
 * It refetches the file on its own (`useFile`) rather than reusing the list
 * row: `preview_url` carries a short-lived signed token minted per single-file
 * GET, so the row's copy is not usable for the preview.
 */

import { useTranslation } from "react-i18next";
import { DownloadIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { useFile, useFileDownload } from "../hooks/use-files";
import { FileViewer } from "./file-viewer";
import { LoadingState } from "./page-states";

/** Shared by the viewer and its placeholder — move both or neither. */
const VIEWER_HEIGHT = "h-[max(24rem,calc(100vh-28rem))]";

export function RunFeaturedFile({ id, name }: { id: string; name: string }) {
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
        className={VIEWER_HEIGHT}
      />
    </section>
  );
}

/**
 * The same footprint, before the file's identity is known.
 *
 * The Outcome pane learns "this run produced exactly one file" from the run
 * DTO's count, a paint or two before `/api/files` tells it WHICH file. Without
 * something holding the slot, that window would either show the other shape
 * (the list card) and swap, or show nothing and shove the whole pane down when
 * the viewer arrives. It carries no name and no download button because there
 * is no file to name or download yet — the header row is reserved, not faked,
 * and `h-8` is the height of the `size="sm"` button that will land in it.
 */
export function RunFeaturedFilePlaceholder() {
  return (
    <section aria-hidden className="mb-4 min-w-0">
      <div className="mb-2 h-8" />
      <div className={`bg-muted overflow-hidden rounded-md border ${VIEWER_HEIGHT}`}>
        <LoadingState />
      </div>
    </section>
  );
}
