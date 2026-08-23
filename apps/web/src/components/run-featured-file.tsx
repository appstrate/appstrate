// SPDX-License-Identifier: Apache-2.0

/**
 * The one file a run produced, previewed in place.
 *
 * Its own module because two panes render it — Outcome (where the produced
 * files live) and Files (the complete list) — and the derived presentation rule
 * (#1177) has to look identical on both: exactly one produced file is featured
 * and opened, several are only listed.
 *
 * WHERE the two panes deliberately differ is the surroundings, not the rule:
 *
 *   - Files keeps the viewer ABOVE its own list, because that pane's job is the
 *     complete inventory — inputs included — and the featured file is a preview
 *     bolted on top of a list that still has to be there.
 *   - Outcome HOISTS it: at exactly one produced file the pane drops its
 *     "Fichiers produits" card entirely and this section is the pane's first
 *     child, above Output. A card there would have listed the single file as one
 *     row directly under a full-size preview of that same file.
 *
 * Both still ask `featuredRunFile()` the same question and get the same
 * answer; only the container around this component changes.
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
