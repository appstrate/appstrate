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
import { FileText } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import {
  useDeleteDocument,
  useDocumentDownload,
  useKeepDocument,
  type DocumentDto,
} from "../hooks/use-documents";
import { ErrorState, EmptyState } from "./page-states";
import { CardGrid } from "./card-grid";
import { DocumentTile } from "./document-tile";
import { DocumentPreview } from "./document-preview";
import { ConfirmModal } from "./confirm-modal";

export type PurposeFilter = "all" | "agent_output" | "user_upload";

const PURPOSE_TABS: PurposeFilter[] = ["all", "agent_output", "user_upload"];

export function DocumentListPanel({
  documents,
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
  documents: DocumentDto[];
  isLoading: boolean;
  error: unknown;
  purpose: PurposeFilter;
  onPurposeChange: (p: PurposeFilter) => void;
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
}) {
  const { t } = useTranslation("documents");
  const download = useDocumentDownload();
  const deleteDoc = useDeleteDocument();
  const keepDoc = useKeepDocument();
  const location = useLocation();
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<DocumentDto | null>(null);

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

  return (
    <>
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

      <div className="flex flex-col gap-3">
        {/* The gallery is a card grid and always was — it just drew its own,
            with the states above it in the wrong order (loading before failure,
            so a 500 under a stale page showed a spinner). `min` is 10rem here:
            these cards are thumbnails, and the family's 20rem default would
            make each one a poster. */}
        <CardGrid
          items={documents}
          min="10rem"
          itemKey={(doc) => doc.id}
          isLoading={isLoading}
          isError={Boolean(error)}
          error={<ErrorState message={getErrorMessage(error)} compact />}
          empty={
            <EmptyState
              message={empty.message}
              hint={empty.hint}
              compact={empty.compact}
              icon={FileText}
            />
          }
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
        {/* "Load more" belongs to a list that has rows to extend. */}
        {documents.length > 0 && footer}
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
