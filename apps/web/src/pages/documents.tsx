// SPDX-License-Identifier: Apache-2.0

/**
 * Documents gallery. Paginated (keyset "load more") list of every document
 * visible to the caller in the current application, with a purpose filter.
 * Visibility is the API's (container-inherited ACL): members see the app's
 * documents, end-users see only their own.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { formatBytes } from "@appstrate/core/format";
import { $api } from "../api/client";
import { useOrg } from "../hooks/use-org";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { useDocuments, type DocumentDto } from "../hooks/use-documents";
import { PageHeader } from "../components/page-header";
import { DocumentListPanel, type PurposeFilter } from "../components/document-list-panel";

/**
 * A single storage-usage line ("X used / Y limit") with a conditional warning
 * when consumption has reached or passed the effective limit — at which point
 * new document writes are rejected (403) while existing documents stay intact.
 * `effective_limit_bytes` null = unlimited: the line collapses to "X used".
 */
function StorageUsageLine() {
  const { t } = useTranslation(["documents"]);
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const { data: orgDetail } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: !!orgId },
  );
  const storage = orgDetail?.storage;
  if (!storage) return null;

  const limit = storage.effective_limit_bytes;
  const over = limit !== null && storage.used_bytes >= limit;

  return (
    <div className="mb-4">
      <p className="text-muted-foreground text-sm tabular-nums">
        {limit === null
          ? t("storage.usedUnlimited", { used: formatBytes(storage.used_bytes) })
          : t("storage.usedOfLimit", {
              used: formatBytes(storage.used_bytes),
              limit: formatBytes(limit),
            })}
      </p>
      {over && (
        <Alert variant="warning" className="mt-2">
          <AlertTriangle size={16} />
          <AlertDescription>{t("storage.limitReached")}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

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

      <StorageUsageLine />

      <DocumentListPanel
        documents={documents}
        isLoading={isLoading}
        error={error}
        purpose={purpose}
        onPurposeChange={resetPaging}
        empty={{ message: t("page.empty"), hint: t("page.emptyHint") }}
        showRunLink
        onDeleted={(id) => setLoadedPages((prev) => prev.filter((d) => d.id !== id))}
        onKept={(id) =>
          setLoadedPages((prev) => prev.map((d) => (d.id === id ? { ...d, expiresAt: null } : d)))
        }
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
