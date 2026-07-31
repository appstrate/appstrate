// SPDX-License-Identifier: Apache-2.0

/** Desktop side-by-side document viewer used by the chat artefact surface. */

import { DownloadIcon, SparklesIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { DocumentViewer } from "../../components/document-viewer";
import { useDocument, useDocumentDownload } from "../../hooks/use-documents";

export function ChatDocumentPanel({
  doc,
  onClose,
}: {
  doc: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation(["chat", "documents"]);
  const download = useDocumentDownload();
  const { data, isLoading, error } = useDocument(doc.id);
  const name = doc.name || data?.name || t("artifact.untitled", { ns: "chat" });
  const downloadButton = data?.downloadable ? (
    <Button variant="ghost" size="sm" onClick={() => void download(doc.id, name)}>
      <DownloadIcon className="size-4" />
      {t("row.download", { ns: "documents" })}
    </Button>
  ) : null;

  return (
    <aside
      aria-label={t("artifact.panelLabel", { ns: "chat" })}
      className="bg-background flex h-full w-[46vw] max-w-[56rem] min-w-[28rem] shrink-0 flex-col border-l"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3" aria-live="polite">
        <SparklesIcon className="text-primary size-4 shrink-0" />
        <span className="text-muted-foreground shrink-0 text-xs font-medium tracking-wide uppercase">
          {t("artifact.label", { ns: "chat" })}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>
          {name}
        </span>
        {downloadButton}
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t("artifact.close", { ns: "chat" })}
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 p-3">
        <DocumentViewer
          documentId={doc.id}
          document={data}
          isLoading={isLoading}
          error={error}
          unavailableAction={downloadButton}
        />
      </div>
    </aside>
  );
}
