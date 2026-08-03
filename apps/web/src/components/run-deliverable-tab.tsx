// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DownloadIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { ApiError } from "../api/errors";
import { useDocument, useDocumentDownload } from "../hooks/use-documents";
import { DocumentViewer } from "./document-viewer";

export function RunDeliverableTab({
  documentId,
  onUnavailable,
}: {
  documentId: string;
  onUnavailable: (documentId: string) => void;
}) {
  const { t } = useTranslation(["agents", "documents"]);
  const download = useDocumentDownload();
  const { data, isLoading, error } = useDocument(documentId);
  useEffect(() => {
    // A background refresh may retain usable data alongside a transient error;
    // only reconcile the run pointer when the authoritative API says the
    // document no longer exists. Network/5xx failures must not hide a valid
    // deliverable while the platform is temporarily unavailable.
    if (error instanceof ApiError && error.status === 404 && !data) {
      onUnavailable(documentId);
    }
  }, [data, documentId, error, onUnavailable]);
  const documentName = data?.name ?? "";
  const downloadButton = data ? (
    <Button variant="outline" size="sm" onClick={() => void download(documentId, documentName)}>
      <DownloadIcon className="size-4" />
      {t("row.download", { ns: "documents" })}
    </Button>
  ) : null;

  return (
    <section aria-label={t("run.deliverableLabel")} className="min-w-0">
      {data && (
        <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
          <h2 className="truncate text-sm font-medium" title={documentName}>
            {documentName}
          </h2>
          {data.preview_url && downloadButton}
        </div>
      )}
      <DocumentViewer
        documentId={documentId}
        document={data}
        isLoading={isLoading}
        error={error}
        unavailableAction={downloadButton}
        className="h-[max(28rem,calc(100vh-20rem))]"
      />
    </section>
  );
}
