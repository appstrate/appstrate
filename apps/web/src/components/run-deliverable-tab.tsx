// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DownloadIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { ApiError } from "../api/errors";
import { useFile, useFileDownload } from "../hooks/use-files";
import { FileViewer } from "./file-viewer";

export function RunDeliverableTab({
  fileId,
  onUnavailable,
}: {
  fileId: string;
  onUnavailable: (fileId: string) => void;
}) {
  const { t } = useTranslation(["agents", "files"]);
  const download = useFileDownload();
  const { data, isLoading, error } = useFile(fileId);
  useEffect(() => {
    // A background refresh may retain usable data alongside a transient error;
    // only reconcile the run pointer when the authoritative API says the file
    // no longer exists. Network/5xx failures must not hide a valid deliverable
    // while the platform is temporarily unavailable.
    if (error instanceof ApiError && error.status === 404 && !data) {
      onUnavailable(fileId);
    }
  }, [data, fileId, error, onUnavailable]);
  const fileName = data?.name ?? "";
  const downloadButton = data ? (
    <Button variant="outline" size="sm" onClick={() => void download(fileId, fileName)}>
      <DownloadIcon className="size-4" />
      {t("row.download", { ns: "files" })}
    </Button>
  ) : null;

  return (
    <section aria-label={t("run.deliverableLabel")} className="min-w-0">
      {data && (
        <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
          <h2 className="truncate text-sm font-medium" title={fileName}>
            {fileName}
          </h2>
          {data.preview_url && downloadButton}
        </div>
      )}
      <FileViewer
        fileId={fileId}
        file={data}
        isLoading={isLoading}
        error={error}
        unavailableAction={downloadButton}
        className="h-[max(28rem,calc(100vh-20rem))]"
      />
    </section>
  );
}
