// SPDX-License-Identifier: Apache-2.0

/**
 * Shared documents panel — loading/error/empty states, the two bodies
 * (table, compact list), and the delete + preview modals. Used by the
 * gallery page and the run page. Data fetching and pagination stay with the
 * caller; this component is fed an already-resolved list and owns only the
 * delete/preview interaction (download + delete gating live here since they
 * are identical on every surface).
 */

import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { useDeleteFile, useFileDownload, useKeepFile, type FileDto } from "../hooks/use-files";
import { EmptyState } from "./page-states";
import { ItemList } from "./item-list";
import { DataTable } from "./data-table";
import type { ColumnMenuSpec } from "./list-toolbar";
import { useDocumentColumns } from "./document-columns";
import { DocumentRowActions } from "./document-row-actions";
import { FilePreview } from "./file-preview";
import { ConfirmModal } from "./confirm-modal";
import { useUrlModal } from "../hooks/use-url-modal";
import { useColumnVisibility } from "../stores/column-visibility-store";

export function DocumentListPanel({
  documents,
  isLoading,
  error,
  empty,
  showRunLink,
  footer,
  display = "table",
  toolbar,
  tableLabel,
  tiered,
  tableSurface = "framed",
}: {
  documents: FileDto[];
  isLoading: boolean;
  error: unknown;
  empty: { message: string; hint?: string; compact?: boolean };
  /** Gallery tiles link to the producing run. */
  showRunLink?: boolean;
  /** Rendered after the list: the gallery's "Load more", a run's truncation notice. */
  footer?: ReactNode;
  /** The Documents page and a run's results draw a table; a run's inputs list compactly. */
  display?: "table" | "compact";
  /** Apparatus owned by the caller, built from the table's real columns. */
  toolbar?: (context: { columns: ColumnMenuSpec }) => ReactNode;
  tableLabel?: string;
  /** Read columns wait for room by their tier (a narrow panel); see `DataTable`. */
  tiered?: boolean;
  /** Integrated rails already provide the surrounding surface. */
  tableSurface?: "framed" | "integrated";
}) {
  const { t } = useTranslation("files");
  const download = useFileDownload();
  const deleteDoc = useDeleteFile();
  const keepDoc = useKeepFile();
  const [pendingDelete, setPendingDelete] = useState<FileDto | null>(null);

  // A deep-linked doc may be outside the currently loaded page, so an empty name
  // is fine — the preview modal falls back to the fetched DTO's name.
  const preview = useUrlModal("preview");
  const previewDoc = preview.value
    ? { id: preview.value, name: documents.find((d) => d.id === preview.value)?.name ?? "" }
    : null;

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
  const { columns, menu } = useColumnVisibility("documents", allColumns);
  const emptyState = (
    <EmptyState message={empty.message} hint={empty.hint} compact={empty.compact} icon={FileText} />
  );

  return (
    <>
      {toolbar?.({ columns: menu })}

      <div className="flex flex-col gap-3">
        {display === "compact" ? (
          <ItemList
            items={documents}
            itemKey={(doc) => doc.id}
            isLoading={isLoading && documents.length === 0}
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
                  onPreview={(d) => preview.open(d.id)}
                  onDownload={onDownload}
                  onKeep={onKeep}
                  onDelete={onDelete}
                />
              </div>
            )}
          />
        ) : (
          <DataTable
            tableId="documents"
            label={tableLabel ?? t("tableLabel")}
            columns={columns}
            tiered={tiered}
            surface={tableSurface}
            rows={documents}
            rowKey={(doc) => doc.id}
            rowAction={(doc) => preview.open(doc.id)}
            rowActionable={(doc) => doc.capabilities.preview}
            rowLabel={(doc) => doc.name}
            isLoading={isLoading && documents.length === 0}
            failure={error}
            empty={emptyState}
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
        confirmLabel={t("common:btn.delete")}
        isPending={deleteDoc.isPending}
      />

      {previewDoc && <FilePreview file={previewDoc} onClose={preview.close} />}
    </>
  );
}
