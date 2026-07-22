// SPDX-License-Identifier: Apache-2.0

/**
 * Documents gallery. Paginated (keyset "load more") list of every document
 * visible to the caller in the current application, with a purpose filter.
 * Visibility is the API's (container-inherited ACL): members see the app's
 * documents, end-users see only their own.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { useDocuments, type DocumentDto } from "../hooks/use-documents";
import { PageHeader } from "../components/page-header";
import { DocumentListPanel, type PurposeFilter } from "../components/document-list-panel";

export function DocumentsPage() {
  // Remount on application switch so the cursor + accumulated pages reset.
  const applicationId = useCurrentApplicationId();
  return <DocumentsPageContent key={applicationId ?? "none"} />;
}

function DocumentsPageContent() {
  const { t } = useTranslation(["documents", "common"]);

  const [purpose, setPurpose] = useState<PurposeFilter>("all");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadedPages, setLoadedPages] = useState<DocumentDto[]>([]);

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

      <DocumentListPanel
        documents={documents}
        isLoading={isLoading}
        error={error}
        purpose={purpose}
        onPurposeChange={resetPaging}
        empty={{ message: t("page.empty"), hint: t("page.emptyHint") }}
        showRunLink
        onDeleted={(id) => setLoadedPages((prev) => prev.filter((d) => d.id !== id))}
        footer={
          hasMore && (
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
          )
        }
      />
    </div>
  );
}
