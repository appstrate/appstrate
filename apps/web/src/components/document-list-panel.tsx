// SPDX-License-Identifier: Apache-2.0

/**
 * Shared documents panel — the purpose tab strip, loading/error/empty states,
 * the DocumentTile grid, and the delete + preview modals. Used by both the
 * gallery page and the run-detail Documents tab. Data fetching and pagination
 * stay with the caller; this component is fed an already-resolved list and owns
 * only the delete/preview interaction (download + delete gating live here since
 * they are identical on both surfaces).
 */

import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Download, Eye, FileText, Pin, Trash2 } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import {
  useDeleteDocument,
  useDocumentDownload,
  useKeepDocument,
  type DocumentDto,
} from "../hooks/use-documents";
import { ErrorState, EmptyState } from "./page-states";
import { CardGrid } from "./card-grid";
import { DataTable, columnMenu, visibleColumns } from "./data-table";
import type { ColumnMenuSpec } from "./list-toolbar";
import { DocumentTile } from "./document-tile";
import { useDocumentColumns } from "./document-columns";
import { DocumentPreview } from "./document-preview";
import { ConfirmModal } from "./confirm-modal";
import { TableRowActions } from "./table-row-actions";
import { documentPreviewHref } from "../lib/documents";
import { useColumnVisibility } from "../stores/column-visibility-store";

export type PurposeFilter = "all" | "agent_output" | "user_upload";

const PURPOSE_TABS: PurposeFilter[] = ["all", "agent_output", "user_upload"];
const ignorePurposeChange = () => undefined;

export function DocumentListPanel({
  documents,
  isLoading,
  error,
  purpose = "all",
  onPurposeChange = ignorePurposeChange,
  empty,
  showRunLink,
  runId,
  footer,
  onDeleted,
  onKept,
  display = "cards",
  showPurposeTabs = true,
  toolbar,
  tableLabel,
  tableColumnMode = "tiered",
  tableSurface = "framed",
  tableShowHeader = true,
}: {
  documents: DocumentDto[];
  isLoading: boolean;
  error: unknown;
  purpose?: PurposeFilter;
  onPurposeChange?: (p: PurposeFilter) => void;
  empty: { message: string; hint?: string; compact?: boolean };
  /** Gallery tiles link to the producing run. */
  showRunLink?: boolean;
  /**
   * Run-tab only: the run this panel belongs to. When set, each tile shows an
   * input/output badge — a doc anchored to this run is an output, anything else
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
  /** The main Documents page offers both; compact run tabs keep the gallery. */
  display?: "cards" | "table" | "compact";
  /** The main page puts this dimension in ListToolbar instead of a tab strip. */
  showPurposeTabs?: boolean;
  /** Apparatus owned by the caller, built from the table's real columns. */
  toolbar?: (context: { columns: ColumnMenuSpec }) => ReactNode;
  tableLabel?: string;
  /** Level-one collections keep every reader-selected column reachable. */
  tableColumnMode?: "tiered" | "scroll";
  /** Integrated rails already provide the surrounding surface. */
  tableSurface?: "framed" | "integrated";
  /** The compact snapshot list names the group in its accordion trigger. */
  tableShowHeader?: boolean;
}) {
  const { t } = useTranslation("documents");
  const download = useDocumentDownload();
  const deleteDoc = useDeleteDocument();
  const keepDoc = useKeepDocument();
  const location = useLocation();
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<DocumentDto | null>(null);
  const visibility = useColumnVisibility("documents");

  // Preview is URL-addressable via a `?preview=<doc_id>` param so it can be
  // deep-linked and shared, and the browser back button closes it. A deep-linked
  // doc may be outside the currently loaded page, so an empty name is fine — the
  // preview modal falls back to the fetched DTO's name.
  const previewId = new URLSearchParams(location.search).get("preview");
  const previewDoc = previewId
    ? { id: previewId, name: documents.find((d) => d.id === previewId)?.name ?? "" }
    : null;

  // Navigate while preserving the URL hash (the run page keeps its active tab in
  // the hash — react-router's setSearchParams would drop it) and any other
  // existing search params.
  //
  // Opening PUSHES (so the back button closes the preview); closing REPLACES.
  // Pushing on close too would stack `[page, page?preview=x, page]`, and then
  // "back" from the closed state would REOPEN the preview instead of leaving
  // the page — worse with every document consulted.
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

  // Wire the delete/keep handlers unconditionally — per-document visibility is
  // driven by the server-computed `capabilities` (delete/keep) inside the tile,
  // not a client-side role guess. The server still enforces the real rule.
  const onDelete = (doc: DocumentDto) => setPendingDelete(doc);

  // Keep ("pin") — clears the document's expiry.
  const onKeep = (doc: DocumentDto) =>
    keepDoc.mutate(
      { params: { path: { id: doc.id } } },
      {
        onSuccess: () => {
          toast.success(t("keep.success"));
          onKept?.(doc.id);
        },
        onError: (err) => toast.error(getErrorMessage(err)),
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
        onError: (err) => toast.error(getErrorMessage(err)),
      },
    );
  };

  const pendingKeepId = keepDoc.isPending ? (keepDoc.variables?.params.path.id ?? null) : null;
  const allColumns = useDocumentColumns({
    pendingKeepId,
    showRunLink,
    onDownload: (doc) => void download(doc.id, doc.name),
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

      {showPurposeTabs && (
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

      <div className="flex flex-col gap-3">
        {display === "compact" ? (
          isLoading ? (
            <Skeleton className="h-7 w-full" />
          ) : error ? (
            <ErrorState message={getErrorMessage(error)} compact />
          ) : documents.length === 0 ? (
            emptyState
          ) : (
            <ul className="grid gap-1">
              {documents.map((doc) => {
                const canKeep = doc.capabilities.keep && Boolean(doc.expiresAt);
                const hasMenu = Boolean(
                  doc.capabilities.preview ||
                  doc.capabilities.download ||
                  canKeep ||
                  doc.capabilities.delete,
                );
                const hasNonDestructiveAction = Boolean(
                  doc.capabilities.preview || doc.capabilities.download || canKeep,
                );

                return (
                  <li key={doc.id} className="flex min-w-0 items-center gap-2 py-0.5">
                    <span className="min-w-0 flex-1 truncate text-sm" title={doc.name}>
                      {doc.name}
                    </span>
                    <TableRowActions
                      menuLabel={hasMenu ? t("row.moreActions", { name: doc.name }) : undefined}
                      isPending={pendingKeepId === doc.id}
                    >
                      {hasMenu ? (
                        <>
                          {doc.capabilities.preview && (
                            <DropdownMenuItem onSelect={() => setPreviewParam(doc.id)}>
                              <Eye />
                              {t("row.preview")}
                            </DropdownMenuItem>
                          )}
                          {doc.capabilities.download && (
                            <DropdownMenuItem onSelect={() => void download(doc.id, doc.name)}>
                              <Download />
                              {t("row.download")}
                            </DropdownMenuItem>
                          )}
                          {canKeep && (
                            <DropdownMenuItem onSelect={() => onKeep(doc)}>
                              <Pin />
                              {t("row.keep")}
                            </DropdownMenuItem>
                          )}
                          {doc.capabilities.delete && (
                            <>
                              {hasNonDestructiveAction && <DropdownMenuSeparator />}
                              <DropdownMenuItem
                                onSelect={() => onDelete(doc)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 />
                                {t("row.delete")}
                              </DropdownMenuItem>
                            </>
                          )}
                        </>
                      ) : undefined}
                    </TableRowActions>
                  </li>
                );
              })}
            </ul>
          )
        ) : display === "table" ? (
          <DataTable
            label={tableLabel ?? t("tableLabel")}
            columns={columns}
            columnMode={tableColumnMode}
            surface={tableSurface}
            showHeader={tableShowHeader}
            rows={documents}
            rowKey={(doc) => doc.id}
            rowHref={(doc) =>
              doc.capabilities.preview ? documentPreviewHref(location, doc.id) : undefined
            }
            rowLabel={(doc) => doc.name}
            isLoading={isLoading}
            isError={Boolean(error)}
            error={<ErrorState message={getErrorMessage(error)} compact />}
            empty={emptyState}
          />
        ) : (
          /* The same real tiles serve the main card view and compact run tabs. */
          <CardGrid
            items={documents}
            min="10rem"
            itemKey={(doc) => doc.id}
            isLoading={isLoading}
            isError={Boolean(error)}
            error={<ErrorState message={getErrorMessage(error)} compact />}
            empty={emptyState}
            renderCard={(doc) => (
              <DocumentTile
                doc={doc}
                onDownload={download}
                onDelete={onDelete}
                onKeep={onKeep}
                onPreview={(d) => setPreviewParam(d.id)}
                showRunLink={showRunLink}
                direction={runId ? (doc.run_id === runId ? "output" : "input") : undefined}
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

      {previewDoc && <DocumentPreview doc={previewDoc} onClose={() => setPreviewParam(null)} />}
    </>
  );
}
