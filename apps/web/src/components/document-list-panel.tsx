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
import { usePermissions } from "../hooks/use-permissions";
import { LoadingState, ErrorState, EmptyState } from "./page-states";
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
  const { isMember } = usePermissions();
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
  // existing search params. Both open and close PUSH a history entry, so the
  // back button from an open modal lands on the param-less URL and closes it.
  const setPreviewParam = (id: string | null) => {
    const params = new URLSearchParams(location.search);
    if (id) params.set("preview", id);
    else params.delete("preview");
    const search = params.toString();
    navigate({
      pathname: location.pathname,
      search: search ? `?${search}` : "",
      hash: location.hash,
    });
  };

  const onDelete = isMember ? (doc: DocumentDto) => setPendingDelete(doc) : undefined;

  // Keep ("pin") — clears the document's expiry. Same member gate as delete; the
  // server enforces the real creator-OR-permission rule.
  const onKeep = isMember
    ? (doc: DocumentDto) =>
        keepDoc.mutate(
          { params: { path: { id: doc.id } } },
          {
            onSuccess: () => {
              toast.success(t("keep.success"));
              onKept?.(doc.id);
            },
            onError: (err) => toast.error(getErrorMessage(err)),
          },
        )
    : undefined;

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

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={getErrorMessage(error)} />
      ) : documents.length === 0 ? (
        <EmptyState
          message={empty.message}
          hint={empty.hint}
          compact={empty.compact}
          icon={FileText}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid [grid-template-columns:repeat(auto-fill,minmax(10rem,1fr))] gap-3">
            {documents.map((doc) => (
              <DocumentTile
                key={doc.id}
                doc={doc}
                onDownload={download}
                onDelete={onDelete}
                onKeep={onKeep}
                onPreview={(d) => setPreviewParam(d.id)}
                showRunLink={showRunLink}
                direction={runId ? (doc.run_id === runId ? "output" : "input") : undefined}
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
        isPending={deleteDoc.isPending}
      />

      {previewDoc && (
        <DocumentPreview
          doc={previewDoc}
          open={!!previewDoc}
          onClose={() => setPreviewParam(null)}
        />
      )}
    </>
  );
}
