// SPDX-License-Identifier: Apache-2.0

/**
 * The one file a run produced, previewed in place.
 *
 * Its own module because two panes render it — Outcome (where the produced
 * files live) and Files (the complete list) — and the derived presentation rule
 * (#1177) has to look identical on both: exactly one produced file is featured
 * and opened, several are only listed.
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
        className="h-[max(24rem,calc(100vh-28rem))]"
      />
    </section>
  );
}
