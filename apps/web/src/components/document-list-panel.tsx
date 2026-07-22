// SPDX-License-Identifier: Apache-2.0

/**
 * Shared documents panel — the purpose tab strip, loading/error/empty states,
 * the DocumentRow list, and the delete + preview modals. Used by both the
 * gallery page and the run-detail Documents tab. Data fetching and pagination
 * stay with the caller; this component is fed an already-resolved list and owns
 * only the delete/preview interaction (download + delete gating live here since
 * they are identical on both surfaces).
 */

import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import { useDeleteDocument, useDocumentDownload, type DocumentDto } from "../hooks/use-documents";
import { usePermissions } from "../hooks/use-permissions";
import { LoadingState, ErrorState, EmptyState } from "./page-states";
import { DocumentRow } from "./document-row";
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
  footer,
  onDeleted,
}: {
  documents: DocumentDto[];
  isLoading: boolean;
  error: unknown;
  purpose: PurposeFilter;
  onPurposeChange: (p: PurposeFilter) => void;
  empty: { message: string; hint?: string; compact?: boolean };
  /** Gallery rows link to the producing run. */
  showRunLink?: boolean;
  /** Gallery's "Load more" control, rendered after the list. */
  footer?: ReactNode;
  /** Let the caller prune its own list (e.g. the gallery's page accumulator). */
  onDeleted?: (id: string) => void;
}) {
  const { t } = useTranslation("documents");
  const { isMember } = usePermissions();
  const download = useDocumentDownload();
  const deleteDoc = useDeleteDocument();
  const [pendingDelete, setPendingDelete] = useState<DocumentDto | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentDto | null>(null);

  const onDelete = isMember ? (doc: DocumentDto) => setPendingDelete(doc) : undefined;

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
        <div className="flex flex-col gap-2">
          {documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              onDownload={download}
              onDelete={onDelete}
              onPreview={setPreviewDoc}
              showRunLink={showRunLink}
            />
          ))}
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
        <DocumentPreview doc={previewDoc} open={!!previewDoc} onClose={() => setPreviewDoc(null)} />
      )}
    </>
  );
}
