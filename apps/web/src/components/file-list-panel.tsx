// SPDX-License-Identifier: Apache-2.0

/**
 * Shared files panel — the purpose tab strip, loading/error/empty states,
 * the FileTile grid, and the delete + preview modals. Used by both the
 * gallery page and the run-detail Files tab. Data fetching and pagination
 * stay with the caller; this component is fed an already-resolved list and owns
 * only the delete/preview interaction (download + delete gating live here since
 * they are identical on both surfaces).
 */

import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import { useDeleteFile, useFileDownload, useKeepFile, type FileDto } from "../hooks/use-files";
import { LoadingState, ErrorState, EmptyState } from "./page-states";
import { FileTile } from "./file-tile";
import { FilePreview } from "./file-preview";
import { ConfirmModal } from "./confirm-modal";

export type PurposeFilter = "all" | "agent_output" | "user_upload";

const PURPOSE_TABS: PurposeFilter[] = ["all", "agent_output", "user_upload"];

export function FileListPanel({
  files,
  isLoading,
  error,
  purpose,
  onPurposeChange,
  empty,
  showRunLink,
  runId,
  footer,
  onDeleted,
  onKept,
}: {
  files: FileDto[];
  isLoading: boolean;
  error: unknown;
  /**
   * The active purpose filter, and the callback that changes it. BOTH optional,
   * and the strip renders only when they are given: the Outcome pane shows one
   * purpose by construction (what the run produced), so a filter offering to
   * widen it back to the uploads would contradict the pane it sits in.
   */
  purpose?: PurposeFilter;
  onPurposeChange?: (p: PurposeFilter) => void;
  empty: { message: string; hint?: string; compact?: boolean };
  /** Gallery tiles link to the producing run. */
  showRunLink?: boolean;
  /**
   * Run-tab only: the run this panel belongs to. When set, each tile shows an
   * input/output badge — a file anchored to this run is an output, anything else
   * (a differently-anchored or unanchored upload) is an input the run consumed.
   */
  runId?: string;
  /** Gallery's "Load more" control, rendered after the grid. */
  footer?: ReactNode;
  /** Let the caller prune its own list (e.g. the gallery's page accumulator). */
  onDeleted?: (id: string) => void;
  /**
   * Let the caller patch its own list after a "keep" (e.g. the gallery's page
   * accumulator, whose older pages the query invalidation does not refetch) so
   * the pinned row loses its expiry badge without a full remount.
   */
  onKept?: (id: string) => void;
}) {
  const { t } = useTranslation("files");
  const download = useFileDownload();
  const deleteFile = useDeleteFile();
  const keepFile = useKeepFile();
  const location = useLocation();
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<FileDto | null>(null);

  // Preview is URL-addressable via a `?preview=<doc_id>` param so it can be
  // deep-linked and shared, and the browser back button closes it. A deep-linked
  // file may be outside the currently loaded page, so an empty name is fine — the
  // preview modal falls back to the fetched DTO's name.
  const previewId = new URLSearchParams(location.search).get("preview");
  const previewFile = previewId
    ? { id: previewId, name: files.find((d) => d.id === previewId)?.name ?? "" }
    : null;

  // Navigate while preserving the URL hash (the run page keeps its active tab in
  // the hash — react-router's setSearchParams would drop it) and any other
  // existing search params.
  //
  // Opening PUSHES (so the back button closes the preview); closing REPLACES.
  // Pushing on close too would stack `[page, page?preview=x, page]`, and then
  // "back" from the closed state would REOPEN the preview instead of leaving
  // the page — worse with every file consulted.
  const setPreviewParam = (id: string | null) => {
    const params = new URLSearchParams(location.search);
    if (id) params.set("preview", id);
    else params.delete("preview");
    const search = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
        hash: location.hash,
      },
      { replace: id === null },
    );
  };

  // Wire the delete/keep handlers unconditionally — per-file visibility is
  // driven by the server-computed `capabilities` (delete/keep) inside the tile,
  // not a client-side role guess. The server still enforces the real rule.
  const onDelete = (file: FileDto) => setPendingDelete(file);

  // Keep ("pin") — clears the file's expiry.
  const onKeep = (file: FileDto) =>
    keepFile.mutate(
      { params: { path: { id: file.id } } },
      {
        onSuccess: () => {
          toast.success(t("keep.success"));
          onKept?.(file.id);
        },
        onError: (err) => toast.error(getErrorMessage(err)),
      },
    );

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    deleteFile.mutate(
      { params: { path: { id } } },
      {
        onSuccess: () => {
          toast.success(t("delete.success"));
          onDeleted?.(id);
          setPendingDelete(null);
        },
        onError: (err) => toast.error(getErrorMessage(err)),
      },
    );
  };

  return (
    <>
      {onPurposeChange && (
        <div className="mb-4 flex items-center gap-1">
          {PURPOSE_TABS.map((p) => (
            <Button
              key={p}
              variant={purpose === p ? "secondary" : "ghost"}
              size="sm"
              onClick={() => onPurposeChange(p)}
            >
              {t(`filter.${p}`)}
            </Button>
          ))}
        </div>
      )}

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={getErrorMessage(error)} />
      ) : files.length === 0 ? (
        <EmptyState
          message={empty.message}
          hint={empty.hint}
          compact={empty.compact}
          icon={FileText}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid [grid-template-columns:repeat(auto-fill,minmax(10rem,1fr))] gap-3">
            {files.map((file) => (
              <FileTile
                key={file.id}
                file={file}
                onDownload={download}
                onDelete={onDelete}
                onKeep={onKeep}
                onPreview={(d) => setPreviewParam(d.id)}
                showRunLink={showRunLink}
                direction={runId ? (file.run_id === runId ? "output" : "input") : undefined}
              />
            ))}
          </div>
          {footer}
        </div>
      )}

      <ConfirmModal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title={t("delete.title")}
        description={t("delete.description", { name: pendingDelete?.name ?? "" })}
        confirmLabel={t("row.delete")}
        isPending={deleteFile.isPending}
      />

      {previewFile && <FilePreview file={previewFile} onClose={() => setPreviewParam(null)} />}
    </>
  );
}
