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
import { useOrgStorage } from "../hooks/use-org-storage";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { useDocuments, type DocumentDto } from "../hooks/use-documents";
import { PageHeader } from "../components/page-header";
import { DocumentListPanel } from "../components/document-list-panel";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { useListParams } from "../lib/list-params";

const PURPOSES = ["agent_output", "user_upload"] as const;

/**
 * A single storage-usage line ("X used / Y limit") with a conditional warning
 * when consumption has reached or passed the effective limit — at which point
 * new document writes are rejected (403) while existing documents stay intact.
 * `effective_limit_bytes` null = unlimited: the line collapses to "X used".
 */
function StorageUsageLine() {
  const { t } = useTranslation(["documents"]);
  const { storage, limitBytes: limit } = useOrgStorage();
  if (!storage) return null;

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
  const list = useListParams(["purpose"]);
  const purposes = list.values("purpose", PURPOSES);
  const effectivePurpose = purposes.length === 1 ? purposes[0] : undefined;

  // The filter signature remounts only the pagination accumulator. This is the
  // same derived reset used by the other lists: no effect mirrors URL state,
  // and changing the filter cannot leave pages from the previous answer mixed
  // into the next one.
  return (
    <DocumentsCollection
      key={purposes.join(",")}
      purposes={purposes}
      effectivePurpose={effectivePurpose}
      onPurposeChange={list.setValues("purpose")}
      onReset={list.reset}
    />
  );
}

function DocumentsCollection({
  purposes,
  effectivePurpose,
  onPurposeChange,
  onReset,
}: {
  purposes: Array<(typeof PURPOSES)[number]>;
  effectivePurpose: (typeof PURPOSES)[number] | undefined;
  onPurposeChange: (values: string[]) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation(["documents", "common"]);

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadedPages, setLoadedPages] = useState<DocumentDto[]>([]);

  const { data, isLoading, error } = useDocuments({
    purpose: effectivePurpose,
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

  const filtering = purposes.length > 0;
  const countLabel = hasMore
    ? t("page.countLoaded", { count: documents.length })
    : t("page.count", { count: documents.length });

  return (
    <div>
      <PageHeader title={t("page.title")} emoji="📄" breadcrumbs={[{ label: t("page.title") }]} />

      <StorageUsageLine />

      <DocumentListPanel
        documents={documents}
        isLoading={isLoading}
        error={error}
        display="table"
        showPurposeTabs={false}
        tableLabel={t("tableLabel")}
        toolbar={({ columns }) => (
          <ListToolbar
            filters={[
              {
                id: "purpose",
                label: t("column.purpose"),
                values: purposes,
                onChange: onPurposeChange,
                options: [
                  { value: "agent_output", label: t("filter.agent_output") },
                  { value: "user_upload", label: t("filter.user_upload") },
                ],
              },
            ]}
            onReset={onReset}
            columns={columns}
          />
        )}
        empty={
          filtering
            ? { message: t("page.noMatch"), compact: true }
            : { message: t("page.empty"), hint: t("page.emptyHint") }
        }
        showRunLink
        onDeleted={(id) => setLoadedPages((prev) => prev.filter((d) => d.id !== id))}
        onKept={(id) =>
          setLoadedPages((prev) => prev.map((d) => (d.id === id ? { ...d, expiresAt: null } : d)))
        }
        footer={
          <ListFooter count={isLoading || error ? undefined : countLabel}>
            {hasMore && (
              <Button
                variant="outline"
                size="sm"
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
          </ListFooter>
        }
      />
    </div>
  );
}
