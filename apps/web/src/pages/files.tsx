// SPDX-License-Identifier: Apache-2.0

/**
 * Files gallery. Paginated (keyset "load more") list of every file
 * visible to the caller in the current space, with a purpose filter.
 * Visibility is the API's (container-inherited ACL): members see the space's
 * files, end-users see only their own.
 */

import { ToneAlert } from "@/components/app-ui/status-variants";
import { PendingButton } from "@/components/app-ui/pending-button";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { AlertDescription } from "@appstrate/ui/components/alert";
import { useOrgStorage } from "../hooks/use-org-storage";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useFilesPaged } from "../hooks/use-files";
import { PageHeader } from "../components/page-header";
import { DocumentListPanel } from "../components/document-list-panel";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { useListParams } from "../lib/list-params";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useListView } from "../stores/list-view-store";
import { useCanReach } from "../hooks/use-can-reach";
import { useDebouncedValue } from "../hooks/use-debounced-value";

const PURPOSES = ["agent_output", "user_upload"] as const;

export function FilesPage() {
  // Remount on space switch so the loaded pages reset.
  const spaceId = useCurrentSpaceId();
  return <DocumentsPageContent key={spaceId ?? "none"} />;
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
  const { t } = useTranslation(["files", "common"]);
  const canReach = useCanReach();
  const [view, setView] = useListView("documents");
  const searchPlaceholder = useSearchPlaceholder(t("page.title"));
  const { storage, limitBytes: limit, usageLabel } = useOrgStorage();
  const query = useDebouncedValue(search);

  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useFilesPaged({
    search: query,
    purpose: effectivePurpose,
  });
  const files = useMemo(() => data?.pages.flatMap((page) => page.data) ?? [], [data]);

  const filtering = purposes.length > 0 || query.trim() !== "";
  const countLabel = hasNextPage
    ? t("page.countLoaded", { count: files.length })
    : t("page.count", { count: files.length });
  const overLimit = storage !== undefined && limit !== null && storage.used_bytes >= limit;
  const footerLabel = usageLabel ? (
    <>
      {countLabel} <span aria-hidden>·</span> {t("storage.usage", { usage: usageLabel })}
    </>
  ) : (
    countLabel
  );

  return (
    <div>
      <PageHeader
        title={t("page.title")}
        variant="collection"
        breadcrumbs={[{ label: t("page.title") }]}
      />

      {overLimit && (
        <ToneAlert variant="warning" className="mb-4">
          <AlertTriangle size={16} />
          <AlertDescription>{t("storage.limitReached")}</AlertDescription>
        </ToneAlert>
      )}

      <DocumentListPanel
        documents={files}
        isLoading={isLoading}
        error={error}
        display={view}
        tableLabel={t("tableLabel")}
        tableColumnMode="scroll"
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
        showRunLink={canReach("/agents/:scope/:name/runs/:runId")}
        footer={
          <ListFooter count={isLoading || error ? undefined : footerLabel}>
            {hasNextPage && (
              <PendingButton
                variant="outline"
                size="sm"
                pending={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                {t("page.loadMore")}
              </PendingButton>
            )}
          </ListFooter>
        }
      />
    </div>
  );
}
