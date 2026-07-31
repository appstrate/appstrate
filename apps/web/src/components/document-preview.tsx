// SPDX-License-Identifier: Apache-2.0

/** Modal wrapper around the reusable document viewer. */

import { useTranslation } from "react-i18next";
import { DownloadIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Modal } from "./modal";
import { useDocument, useDocumentDownload } from "../hooks/use-documents";
import { DocumentViewer } from "./document-viewer";

export function DocumentPreview({
  doc,
  onClose,
}: {
  // Only id + name are needed here (the DTO satisfies this structurally); the
  // rest is refetched via `useDocument`. Keeping the surface minimal lets the
  // chat pass a bare `{ id, name }` without importing the full DTO type.
  doc: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation("documents");
  const download = useDocumentDownload();
  // Callers mount this modal only while it is open, so mounting IS opening:
  // the DTO (and its short-lived preview token) is fetched fresh per open.
  const { data, isLoading, error } = useDocument(doc.id);
  const documentName = doc.name || data?.name || "";
  return (
    <Modal
      open
      onClose={onClose}
      // Deep links (e.g. `?preview=<id>`) may target a doc outside the caller's
      // loaded page, so `doc.name` can be empty — fall back to the fetched DTO's name.
      title={documentName}
      // DialogContent is a grid with auto rows — pin the body row to the
      // remaining height (minmax(0,1fr)) so the iframe previews stretch to the
      // full modal height instead of their intrinsic size.
      className="h-[85vh] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto]"
      actions={
        <Button variant="outline" onClick={() => void download(doc.id, documentName)}>
          <DownloadIcon className="size-4" />
          {t("row.download")}
        </Button>
      }
    >
      <DocumentViewer documentId={doc.id} document={data} isLoading={isLoading} error={error} />
    </Modal>
  );
}
