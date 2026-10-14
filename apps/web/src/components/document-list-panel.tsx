// SPDX-License-Identifier: Apache-2.0

/**
 * Shared documents panel — loading/error/empty states, the three bodies
 * (cards, table, compact list), and the delete + preview modals. Used by the
 * gallery page and the run page. Data fetching and pagination stay with the
 * caller; this component is fed an already-resolved list and owns only the
 * delete/preview interaction (download + delete gating live here since they
 * are identical on every surface).
 */

import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { useDeleteFile, useFileDownload, useKeepFile, type FileDto } from "../hooks/use-files";
import { EmptyState } from "./page-states";
import { CardGrid } from "./card-grid";
import { ItemList } from "./item-list";
import { DataTable } from "./data-table";
import { columnMenu, visibleColumns } from "../lib/column-visibility";
import type { ColumnMenuSpec } from "./list-toolbar";
import { FileTile } from "./file-tile";
import { useDocumentColumns } from "./document-columns";
import { DocumentRowActions } from "./document-row-actions";
import { FilePreview } from "./file-preview";
import { ConfirmModal } from "./confirm-modal";
import { filePreviewHref, runFileDirection } from "../lib/files";
import { useColumnVisibility } from "../stores/column-visibility-store";

export function DocumentListPanel({
  documents,
  isLoading,
  error,
  empty,
  showRunLink,
  runId,
  footer,
  onDeleted,
  onKept,
  display = "cards",
  toolbar,
  tableLabel,
  tableColumnMode = "tiered",
  tableSurface = "framed",
}: {
  documents: FileDto[];
  isLoading: boolean;
  error: unknown;
  empty: { message: string; hint?: string; compact?: boolean };
  /** Gallery tiles link to the producing run. */
  showRunLink?: boolean;
  /**
   * Run-tab only: the run this panel belongs to. When set, each tile shows an
   * input/output badge, read through `runFileDirection`: only this run's own
   * `agent_output` is an output; an upload made for it or a file chained in
   * from an earlier run is an input the run consumed.
   */
  runId?: string;
  /** Rendered after the list: the gallery's "Load more", a run's truncation notice. */
  footer?: ReactNode;
  /** Let the caller prune its own list (e.g. the gallery's page accumulator). */
  onDeleted?: (id: string) => void;
  /**
   * Let the caller patch its own list after a "keep" (e.g. the gallery's page
   * accumulator, whose older pages the query invalidation does not refetch) so
   * the pinned row loses its expiry badge without a full remount.
   */
  onKept?: (id: string) => void;
  /** The main Documents page offers cards and table; the run overview lists compactly. */
  display?: "cards" | "table" | "compact";
  /** Apparatus owned by the caller, built from the table's real columns. */
  toolbar?: (context: { columns: ColumnMenuSpec }) => ReactNode;
  tableLabel?: string;
  /** Level-one collections keep every reader-selected column reachable. */
  tableColumnMode?: "tiered" | "scroll";
  /** Integrated rails already provide the surrounding surface. */
  tableSurface?: "framed" | "integrated";
}) {
  const { t } = useTranslation("files");
  const download = useFileDownload();
  const deleteDoc = useDeleteFile();
  const keepDoc = useKeepFile();
  const location = useLocation();
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<FileDto | null>(null);
  const visibility = useColumnVisibility("documents");

  // Preview is URL-addressable via a `?preview=<doc_id>` param so it can be
  // deep-linked and shared, and the browser back button closes it. A deep-linked
  // doc may be outside the currently loaded page, so an empty name is fine — the
  // preview modal falls back to the fetched DTO's name.
  const previewId = new URLSearchParams(location.search).get("preview");
  const previewDoc = previewId
    ? { id: previewId, name: documents.find((d) => d.id === previewId)?.name ?? "" }
    : null;

  // `filePreviewHref` keeps the hash (the run page's active tab — react-router's
  // setSearchParams would drop it) and the other search params.
  //
  // Opening PUSHES (so the back button closes the preview); closing REPLACES.
  // Pushing on close too would stack `[page, page?preview=x, page]`, and then
  // "back" from the closed state would REOPEN the preview instead of leaving
  // the page — worse with every document consulted.
  const setPreviewParam = (id: string | null) =>
    navigate(filePreviewHref(location, id), { replace: id === null });

  // Wire the delete/keep handlers unconditionally — per-document visibility is
  // driven by the server-computed `capabilities` (delete/keep) inside the tile,
  // not a client-side role guess. The server still enforces the real rule.
  const onDelete = (doc: FileDto) => setPendingDelete(doc);

  // Keep ("pin") — clears the document's expiry.
  const onKeep = (doc: FileDto) =>
    keepDoc.mutate(
      { params: { path: { id: doc.id } } },
      {
        onSuccess: () => {
          toast.success(t("keep.success"));
          onKept?.(doc.id);
        },
      },
    );

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    deleteDoc.mutate(
      { params: { path: { id } } },
      {
        onSuccess: () => {
          toast.success(t("delete.success"));
          onDeleted?.(id);
          setPendingDelete(null);
        },
      },
    );
  };

  const pendingKeepId = keepDoc.isPending ? (keepDoc.variables?.params.path.id ?? null) : null;
  const onDownload = (doc: FileDto) => void download(doc.id, doc.name);
  const allColumns = useDocumentColumns({
    pendingKeepId,
    showRunLink,
    onDownload,
    onKeep,
    onDelete,
  });
  const columns = visibleColumns(allColumns, visibility.hidden);
  const emptyState = (
    <EmptyState message={empty.message} hint={empty.hint} compact={empty.compact} icon={FileText} />
  );

  return (
    <>
      {toolbar?.({ columns: columnMenu(allColumns, visibility) })}

      <div className="flex flex-col gap-3">
        {display === "compact" ? (
          <ItemList
            items={documents}
            itemKey={(doc) => doc.id}
            isLoading={isLoading}
            failure={error}
            empty={emptyState}
            renderItem={(doc) => (
              <div className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm" title={doc.name}>
                  {doc.name}
                </span>
                <DocumentRowActions
                  doc={doc}
                  isPending={pendingKeepId === doc.id}
                  showRunLink={showRunLink}
                  onPreview={(d) => setPreviewParam(d.id)}
                  onDownload={onDownload}
                  onKeep={onKeep}
                  onDelete={onDelete}
                />
              </div>
            )}
          />
        ) : display === "table" ? (
          <DataTable
            tableId="documents"
            label={tableLabel ?? t("tableLabel")}
            columns={columns}
            columnMode={tableColumnMode}
            surface={tableSurface}
            rows={documents}
            rowKey={(doc) => doc.id}
            rowHref={(doc) =>
              doc.capabilities.preview ? filePreviewHref(location, doc.id) : undefined
            }
            rowLabel={(doc) => doc.name}
            isLoading={isLoading}
            failure={error}
            empty={emptyState}
          />
        ) : (
          /* The same real tiles serve the main card view and compact run tabs. */
          <CardGrid
            items={documents}
            min="10rem"
            itemKey={(doc) => doc.id}
            isLoading={isLoading}
            failure={error}
            empty={emptyState}
            renderCard={(doc) => (
              <FileTile
                file={doc}
                onDownload={download}
                onDelete={onDelete}
                onKeep={onKeep}
                onPreview={(d) => setPreviewParam(d.id)}
                showRunLink={showRunLink}
                direction={runId ? runFileDirection(doc, runId) : undefined}
              />
            )}
          />
        )}
        {footer}
      </div>

      <ConfirmModal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title={t("delete.title")}
        description={t("delete.description", { name: pendingDelete?.name ?? "" })}
        confirmLabel={t("row.delete")}
        isPending={deleteDoc.isPending}
      />

      {previewDoc && <FilePreview file={previewDoc} onClose={() => setPreviewParam(null)} />}
    </>
  );
}
