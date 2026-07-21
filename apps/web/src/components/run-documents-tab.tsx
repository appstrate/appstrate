// SPDX-License-Identifier: Apache-2.0

/**
 * Run-detail "Documents" tab. Lists the documents anchored to a run — inputs
 * (user uploads consumed by the run) and outputs (agent-produced files) — in two
 * groups. The list is invalidated live from the run's SSE stream: `run-detail`
 * invalidates this query when a `document.published` log frame arrives.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  useDocuments,
  useDeleteDocument,
  useDocumentDownload,
  type DocumentDto,
} from "../hooks/use-documents";
import { usePermissions } from "../hooks/use-permissions";
import { groupDocumentsByPurpose } from "../lib/documents";
import { LoadingState, ErrorState, EmptyState } from "./page-states";
import { DocumentRow } from "./document-row";
import { DocumentPreview } from "./document-preview";
import { ConfirmModal } from "./confirm-modal";

export function RunDocumentsTab({ runId }: { runId: string }) {
  const { t } = useTranslation("documents");
  const { isMember } = usePermissions();
  const { data, isLoading, error } = useDocuments({ runId, limit: 100 });
  const download = useDocumentDownload();
  const deleteDoc = useDeleteDocument();
  const [pendingDelete, setPendingDelete] = useState<DocumentDto | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentDto | null>(null);

  const { inputs, outputs } = useMemo(
    () => groupDocumentsByPurpose(data?.data ?? []),
    [data?.data],
  );

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

  const total = inputs.length + outputs.length;
  if (total === 0) {
    return (
      <EmptyState message={t("run.empty")} hint={t("run.emptyHint")} icon={FileText} compact />
    );
  }

  const onDelete = isMember ? (doc: DocumentDto) => setPendingDelete(doc) : undefined;

  const confirmDelete = () => {
    if (!pendingDelete) return;
    deleteDoc.mutate(
      { params: { path: { id: pendingDelete.id } } },
      {
        onSuccess: () => {
          toast.success(t("delete.success"));
          setPendingDelete(null);
        },
        onError: (err) => toast.error(getErrorMessage(err)),
      },
    );
  };

  return (
    <div className="space-y-6">
      {outputs.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {t("run.outputs")}
          </h3>
          <div className="flex flex-col gap-2">
            {outputs.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                onDownload={download}
                onDelete={onDelete}
                onPreview={setPreviewDoc}
              />
            ))}
          </div>
        </section>
      )}
      {inputs.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {t("run.inputs")}
          </h3>
          <div className="flex flex-col gap-2">
            {inputs.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                onDownload={download}
                onDelete={onDelete}
                onPreview={setPreviewDoc}
              />
            ))}
          </div>
        </section>
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
    </div>
  );
}
