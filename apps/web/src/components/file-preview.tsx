// SPDX-License-Identifier: Apache-2.0

/** Modal wrapper around the reusable file viewer. */

import { useTranslation } from "react-i18next";
import { DownloadIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Modal } from "./modal";
import { useFile, useFileDownload } from "../hooks/use-files";
import { FileViewer } from "./file-viewer";

export function FilePreview({
  file,
  onClose,
}: {
  // Only id + name are needed here (the DTO satisfies this structurally); the
  // rest is refetched via `useFile`. Keeping the surface minimal lets the
  // chat pass a bare `{ id, name }` without importing the full DTO type.
  file: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation("files");
  const download = useFileDownload();
  // Callers mount this modal only while it is open, so mounting IS opening:
  // the DTO (and its short-lived preview token) is fetched fresh per open.
  const { data, isLoading, error } = useFile(file.id);
  const fileName = file.name || data?.name || "";
  return (
    <Modal
      open
      onClose={onClose}
      // Deep links (e.g. `?preview=<id>`) may target a file outside the caller's
      // loaded page, so `file.name` can be empty — fall back to the fetched DTO's name.
      title={fileName}
      // DialogContent is a grid with auto rows — pin the body row to the
      // remaining height (minmax(0,1fr)) so the iframe previews stretch to the
      // full modal height instead of their intrinsic size.
      className="h-[85vh] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto]"
      actions={
        <Button variant="outline" onClick={() => void download(file.id, fileName)}>
          <DownloadIcon className="size-4" />
          {t("row.download")}
        </Button>
      }
    >
      <FileViewer fileId={file.id} file={data} isLoading={isLoading} error={error} />
    </Modal>
  );
}
