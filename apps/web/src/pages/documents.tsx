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
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useDocumentViewStore } from "../stores/list-view-store";

const PURPOSES = ["agent_output", "user_upload"] as const;

export function DocumentsPage() {
  // Remount on application switch so the cursor + accumulated pages reset.
  const applicationId = useCurrentApplicationId();
  return <DocumentsPageContent key={applicationId ?? "none"} />;
}

function DocumentsPageContent() {
  const list = useListParams(["purpose"]);
  const purposes = list.values("purpose", PURPOSES);
  const effectivePurpose = purposes.length === 1 ? purposes[0] : undefined;
  const search = list.search;

  return (
    <DocumentsCollection
      purposes={purposes}
      effectivePurpose={effectivePurpose}
      search={search}
      onSearchChange={list.setSearch}
      onPurposeChange={list.setValues("purpose")}
      onReset={list.reset}
    />
  );
}

function DocumentsCollection({
  purposes,
  effectivePurpose,
  search,
  onSearchChange,
  onPurposeChange,
  onReset,
}: {
  purposes: Array<(typeof PURPOSES)[number]>;
  effectivePurpose: (typeof PURPOSES)[number] | undefined;
  search: string;
  onSearchChange: (value: string) => void;
  onPurposeChange: (values: string[]) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const view = useDocumentViewStore((state) => state.view);
  const setView = useDocumentViewStore((state) => state.setView);
  const searchPlaceholder = useSearchPlaceholder(t("page.title"));
  const { storage, limitBytes: limit } = useOrgStorage();
  const signature = `${effectivePurpose ?? ""}|${search}`;

  // Search and purpose changes clear pagination without remounting the toolbar:
  // remounting drops search focus and closes the purpose multi-select.
  const [paging, setPaging] = useState<{
    signature: string;
    cursor: string | undefined;
    loadedPages: DocumentDto[];
  }>({ signature, cursor: undefined, loadedPages: [] });
  const cursor = paging.signature === signature ? paging.cursor : undefined;

  const { data, isLoading, error } = useDocuments({
    search: search || undefined,
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
    const priorPages = paging.signature === signature ? paging.loadedPages : [];
    for (const doc of [...priorPages, ...currentPage]) {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        out.push(doc);
      }
    }
    return out;
  }, [paging, signature, currentPage]);

  const filtering = purposes.length > 0 || search.trim() !== "";
  const countLabel = hasMore
    ? t("page.countLoaded", { count: documents.length })
    : t("page.count", { count: documents.length });
  const usageLabel = storage
    ? limit === null
      ? t("storage.usedUnlimited", { used: formatBytes(storage.used_bytes) })
      : t("storage.usedOfLimit", {
          used: formatBytes(storage.used_bytes),
          limit: formatBytes(limit),
        })
    : null;
  const overLimit = storage !== undefined && limit !== null && storage.used_bytes >= limit;
  const footerLabel = usageLabel ? (
    <>
      {countLabel} <span aria-hidden>·</span> {usageLabel}
    </>
  ) : (
    countLabel
  );

  return (
    <div>
      <PageHeader title={t("page.title")} emoji="📄" breadcrumbs={[{ label: t("page.title") }]} />

      {overLimit && (
        <Alert variant="warning" className="mb-4">
          <AlertTriangle size={16} />
          <AlertDescription>{t("storage.limitReached")}</AlertDescription>
        </Alert>
      )}

      <DocumentListPanel
        documents={documents}
        isLoading={isLoading}
        error={error}
        display={view}
        showPurposeTabs={false}
        tableLabel={t("tableLabel")}
        toolbar={({ columns }) => (
          <ListToolbar
            search={{
              value: search,
              onChange: onSearchChange,
              placeholder: searchPlaceholder,
            }}
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
            columns={view === "table" ? columns : undefined}
            view={view}
            onViewChange={setView}
          />
        )}
        empty={
          filtering
            ? { message: t("page.noMatch"), compact: true }
            : { message: t("page.empty"), hint: t("page.emptyHint") }
        }
        showRunLink
        onDeleted={(id) =>
          setPaging((previous) => ({
            signature,
            cursor: previous.signature === signature ? previous.cursor : undefined,
            loadedPages: (previous.signature === signature ? previous.loadedPages : []).filter(
              (document) => document.id !== id,
            ),
          }))
        }
        onKept={(id) =>
          setPaging((previous) => ({
            signature,
            cursor: previous.signature === signature ? previous.cursor : undefined,
            loadedPages: (previous.signature === signature ? previous.loadedPages : []).map(
              (document) => (document.id === id ? { ...document, expiresAt: null } : document),
            ),
          }))
        }
        footer={
          <ListFooter count={isLoading || error ? undefined : footerLabel}>
            {hasMore && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const last = currentPage[currentPage.length - 1];
                  if (last) {
                    setPaging((previous) => ({
                      signature,
                      cursor: last.id,
                      loadedPages: [
                        ...(previous.signature === signature ? previous.loadedPages : []),
                        ...currentPage,
                      ],
                    }));
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
