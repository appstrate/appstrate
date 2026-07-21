// SPDX-License-Identifier: Apache-2.0

/**
 * Documents gallery. Paginated (keyset "load more") list of every document
 * visible to the caller in the current application, with a purpose filter.
 * Visibility is the API's (container-inherited ACL): members see the app's
 * documents, end-users see only their own.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import {
  useDocuments,
  useDeleteDocument,
  useDocumentDownload,
  type DocumentDto,
} from "../hooks/use-documents";
import { usePermissions } from "../hooks/use-permissions";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { DocumentRow } from "../components/document-row";
import { DocumentPreview } from "../components/document-preview";
import { ConfirmModal } from "../components/confirm-modal";

type PurposeFilter = "all" | "user_upload" | "agent_output";

const PURPOSE_TABS: PurposeFilter[] = ["all", "agent_output", "user_upload"];

export function DocumentsPage() {
  // Remount on application switch so the cursor + accumulated pages reset.
  const applicationId = useCurrentApplicationId();
  return <DocumentsPageContent key={applicationId ?? "none"} />;
}

function DocumentsPageContent() {
  const { t } = useTranslation(["documents", "common"]);
  const { isMember } = usePermissions();
  const download = useDocumentDownload();
  const deleteDoc = useDeleteDocument();

  const [purpose, setPurpose] = useState<PurposeFilter>("all");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadedPages, setLoadedPages] = useState<DocumentDto[]>([]);
  const [pendingDelete, setPendingDelete] = useState<DocumentDto | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentDto | null>(null);

  const { data, isLoading, error } = useDocuments({
    purpose: purpose === "all" ? undefined : purpose,
    startingAfter: cursor,
    limit: 25,
  });

  const currentPage = useMemo(() => data?.data ?? [], [data?.data]);
  const hasMore = data?.hasMore ?? false;

  // Merge accumulated pages with the current one, deduping by id (the current
  // page briefly overlaps the accumulator between "Load more" and the fetch).
  const documents = useMemo(() => {
    const seen = new Set<string>();
    const out: DocumentDto[] = [];
    for (const doc of [...loadedPages, ...currentPage]) {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        out.push(doc);
      }
    }
    return out;
  }, [loadedPages, currentPage]);

  const resetPaging = (next: PurposeFilter) => {
    setPurpose(next);
    setCursor(undefined);
    setLoadedPages([]);
  };

  const onDelete = isMember ? (doc: DocumentDto) => setPendingDelete(doc) : undefined;

  const confirmDelete = () => {
    if (!pendingDelete) return;
    deleteDoc.mutate(
      { params: { path: { id: pendingDelete.id } } },
      {
        onSuccess: () => {
          toast.success(t("delete.success"));
          // Drop it from the accumulator so it disappears without a full reset.
          setLoadedPages((prev) => prev.filter((d) => d.id !== pendingDelete.id));
          setPendingDelete(null);
        },
        onError: (err) => toast.error(getErrorMessage(err)),
      },
    );
  };

  return (
    <div className="p-6">
      <PageHeader
        title={t("page.title")}
        emoji="📄"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("page.title") },
        ]}
      />

      <div className="mb-4 flex items-center gap-1">
        {PURPOSE_TABS.map((p) => (
          <Button
            key={p}
            variant={purpose === p ? "secondary" : "ghost"}
            size="sm"
            onClick={() => resetPaging(p)}
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
        <EmptyState message={t("page.empty")} hint={t("page.emptyHint")} icon={FileText} />
      ) : (
        <div className="flex flex-col gap-2">
          {documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              onDownload={download}
              onDelete={onDelete}
              onPreview={setPreviewDoc}
              showRunLink
            />
          ))}

          {hasMore && (
            <Button
              variant="outline"
              className="mt-2"
              onClick={() => {
                const last = currentPage[currentPage.length - 1];
                if (last) {
                  setLoadedPages((prev) => [...prev, ...currentPage]);
                  setCursor(last.id);
                }
              }}
            >
              {t("page.loadMore")}
            </Button>
          )}
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
    </div>
  );
}
