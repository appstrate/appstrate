// SPDX-License-Identifier: Apache-2.0

/**
 * Shared files panel — the filter tab strip, loading/error/empty states,
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
import { runFileDirection, type RunFileDirection } from "../lib/files";
import { useDeleteFile, useFileDownload, useKeepFile, type FileDto } from "../hooks/use-files";
import { LoadingState, ErrorState, EmptyState } from "./page-states";
import { FileTile } from "./file-tile";
import { FilePreview } from "./file-preview";
import { ConfirmModal } from "./confirm-modal";

/** Gallery axis: how the file was created, straight off the stored `purpose`. */
export type PurposeFilter = "all" | "agent_output" | "user_upload";

/** Run axis: which side of the run being viewed the file sits on. */
export type DirectionFilter = "all" | RunFileDirection;

/**
 * The tab strip filters on ONE of two axes, and which one is not a free choice
 * — it follows the surface. A run-scoped panel filters by DIRECTION (what this
 * run produced vs. what it consumed), the only question a run page answers; the
 * gallery has no run to be relative to, so it filters by the stored `purpose`.
 *
 * One discriminated prop rather than a second boolean: the flag would have to
 * mean both "which labels" and "which values are legal", and nothing would stop
 * a `user_upload` value reaching a direction strip. Here `value` and `onChange`
 * stay correlated with `axis`, and both axes render through the SAME strip.
 *
 * Who APPLIES the filter differs by axis, and not arbitrarily. `purpose` is a
 * column, so the gallery pushes it into the list query and pages through the
 * result — re-filtering a keyset page here would silently drop rows. Direction
 * is DERIVED and has no server-side representation, so the panel applies it
 * itself, against the very `runFileDirection` call it badges each tile with:
 * the strip and the badge are then one expression, not two rules to keep in
 * step. That is the whole point — they had already drifted apart once.
 */
type FileFilter =
  | { axis: "purpose"; value: PurposeFilter; onChange: (next: PurposeFilter) => void }
  | { axis: "direction"; value: DirectionFilter; onChange: (next: DirectionFilter) => void };

const FILTER_TABS = {
  purpose: ["all", "agent_output", "user_upload"],
  direction: ["all", "output", "input"],
} as const satisfies Record<FileFilter["axis"], readonly string[]>;

/**
 * The one tab strip, generic over its value domain so neither axis owns a copy.
 * Labels come from `files:filter.<value>`, which is why the two domains use
 * disjoint value names.
 */
function FilterTabs<F extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly F[];
  value: F;
  onChange: (next: F) => void;
}) {
  const { t } = useTranslation("files");
  return (
    <div className="mb-4 flex items-center gap-1">
      {options.map((option) => (
        <Button
          key={option}
          variant={value === option ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onChange(option)}
        >
          {t(`filter.${option}`)}
        </Button>
      ))}
    </div>
  );
}

export function FileListPanel({
  files,
  isLoading,
  error,
  filter,
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
   * The active filter (axis + value + setter). Optional, and the strip renders
   * only when it is given: the Outcome pane shows one direction by construction
   * (what the run produced), so a filter offering to widen it back to the
   * consumed files would contradict the pane it sits in.
   */
  filter?: FileFilter;
  empty: { message: string; hint?: string; compact?: boolean };
  /** Gallery tiles link to the producing run. */
  showRunLink?: boolean;
  /**
   * Run surfaces only: the run this panel belongs to. When set, each tile shows
   * an input/output badge, decided by `runFileDirection` — the same rule the
   * `direction` filter axis uses, so the badge and the strip cannot disagree.
   * A `direction` filter is only meaningful together with this prop.
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

  // The direction axis is derived, so it is resolved here rather than by the
  // caller (see `FileFilter`). Cheap: a run's file list is one page of 100.
  const shown =
    runId && filter?.axis === "direction" && filter.value !== "all"
      ? files.filter((file) => runFileDirection(file, runId) === filter.value)
      : files;

  // Preview is URL-addressable via a `?preview=<file_id>` param so it can be
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
      {filter &&
        (filter.axis === "direction" ? (
          <FilterTabs
            options={FILTER_TABS.direction}
            value={filter.value}
            onChange={filter.onChange}
          />
        ) : (
          <FilterTabs
            options={FILTER_TABS.purpose}
            value={filter.value}
            onChange={filter.onChange}
          />
        ))}

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={getErrorMessage(error)} />
      ) : shown.length === 0 ? (
        <EmptyState
          message={empty.message}
          hint={empty.hint}
          compact={empty.compact}
          icon={FileText}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid [grid-template-columns:repeat(auto-fill,minmax(10rem,1fr))] gap-3">
            {shown.map((file) => (
              <FileTile
                key={file.id}
                file={file}
                onDownload={download}
                onDelete={onDelete}
                onKeep={onKeep}
                onPreview={(d) => setPreviewParam(d.id)}
                showRunLink={showRunLink}
                direction={runId ? runFileDirection(file, runId) : undefined}
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
