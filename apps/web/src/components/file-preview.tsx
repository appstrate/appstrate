// SPDX-License-Identifier: Apache-2.0

/** Modal wrapper around the file's Artifact frame. */

import { Modal } from "./modal";
import { useFile } from "../hooks/use-files";
import { FileArtifact } from "./file-artifact";

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
  // Callers mount this modal only while it is open, so mounting IS opening:
  // the DTO (and its short-lived preview token) is fetched fresh per open.
  const { data, isLoading, error } = useFile(file.id);
  return (
    <Modal
      open
      onClose={onClose}
      // Deep links (e.g. `?preview=<id>`) may target a file outside the caller's
      // loaded page, so `file.name` can be empty — fall back to the fetched DTO's name.
      title={file.name || data?.name || ""}
      // DialogContent is a grid with auto rows — pin the body row to the
      // remaining height (minmax(0,1fr)) so the iframe previews stretch to the
      // full modal height instead of their intrinsic size.
      className="h-[85vh] max-w-5xl grid-rows-[auto_minmax(0,1fr)]"
    >
      {/* The modal already titles the file; the frame carries the rest. */}
      <FileArtifact
        fileId={file.id}
        file={data}
        isLoading={isLoading}
        error={error}
        fallbackName={file.name}
        showName={false}
      />
    </Modal>
  );
}
