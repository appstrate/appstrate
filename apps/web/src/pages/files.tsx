// SPDX-License-Identifier: Apache-2.0

/**
 * Files gallery. Paginated (keyset "load more") list of every file
 * visible to the caller in the current space, or in every space it reaches
 * in « Vue d'ensemble », with a purpose filter. Visibility is the API's
 * (container-inherited ACL): members see the space's files, end-users see only
 * their own.
 */

import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOrgStorage } from "../hooks/use-org-storage";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useFilesPaged, type FileDto } from "../hooks/use-files";
import { PageHeader } from "../components/page-header";
import { ListViewTabs } from "../components/list-view-tabs";
import { useListView } from "../stores/list-view-store";
import { DocumentListPanel } from "../components/document-list-panel";
import { KeysetListFooter, ListToolbar } from "../components/list-toolbar";
import { useListParams } from "../lib/list-params";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { useAdmittingSpaces, useOverviewMode } from "../hooks/use-overview-mode";

const PURPOSES = ["agent_output", "user_upload"] as const;

export function FilesPage() {
  // Remount on space switch so the loaded pages reset.
  const spaceId = useCurrentSpaceId();
  return <DocumentsPageContent key={spaceId ?? "none"} />;
}

function DocumentsPageContent() {
  const { t } = useTranslation(["files", "common"]);
  const list = useListParams(["purpose"]);
  const purposes = list.values("purpose", PURPOSES);
  const search = list.search;
  const { on: spanning } = useOverviewMode();
  const runSpaces = useAdmittingSpaces("runs");
  const [view, setView] = useListView("documents");
  const searchPlaceholder = useSearchPlaceholder(t("common:nav.files"));
  const { storage, limitBytes: limit, usageLabel } = useOrgStorage();
  const query = useDebouncedValue(search);

  const filesQuery = useFilesPaged({
    search: query,
    purpose: purposes.length === 1 ? purposes[0] : undefined,
    spanning,
  });
  const { data, isLoading, error, hasNextPage } = filesQuery;
  const files = useMemo(() => data?.pages.flatMap((page) => page.data) ?? [], [data]);

  // A row's run opens in the row's space: judged by that space's grants.
  const showRunLink = (doc: FileDto) => runSpaces.some((space) => space.id === doc.spaceId);

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
        title={t("common:nav.files")}
        variant="collection"
        breadcrumbs={[{ label: t("common:nav.files") }]}
      />

      {overLimit && (
        <Alert variant="warning" className="mb-4">
          <AlertDescription>{t("storage.limitReached")}</AlertDescription>
        </Alert>
      )}

      <DocumentListPanel
        documents={files}
        display={view}
        isLoading={isLoading}
        error={error}
        tableLabel={t("tableLabel")}
        toolbar={({ columns }) => (
          <ListToolbar
            search={{
              value: search,
              onChange: list.setSearch,
              placeholder: searchPlaceholder,
            }}
            filters={[
              {
                id: "purpose",
                label: t("column.purpose"),
                values: purposes,
                onChange: list.setValues("purpose"),
                options: [
                  { value: "agent_output", label: t("filter.agent_output") },
                  { value: "user_upload", label: t("filter.user_upload") },
                ],
              },
            ]}
            onReset={list.reset}
            columns={view === "table" ? columns : undefined}
            actions={<ListViewTabs view={view} onChange={setView} />}
          />
        )}
        empty={
          filtering
            ? { message: t("page.noMatch"), compact: true, onReset: list.reset }
            : { message: t("page.empty"), hint: t("page.emptyHint") }
        }
        showRunLink={showRunLink}
        spanning={spanning}
        footer={
          <KeysetListFooter
            query={filesQuery}
            loaded={files.length}
            count={footerLabel}
            ready={!isLoading && !error}
          />
        }
      />
    </div>
  );
}
