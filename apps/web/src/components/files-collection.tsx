// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PendingButton } from "@/components/app-ui/pending-button";
import { useOrgStorage } from "../hooks/use-org-storage";
import { useFilesPaged } from "../hooks/use-files";
import { useCanReach } from "../hooks/use-can-reach";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { useSpaceFilter, type SpaceDefault } from "../hooks/use-space-filter";
import { useListView } from "../stores/list-view-store";
import { useListParams } from "../lib/list-params";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { LIST_ADMITS } from "../lib/space-lists";
import { ListViewTabs } from "./list-view-tabs";
import { DocumentListPanel } from "./document-list-panel";
import { ListFooter, ListToolbar } from "./list-toolbar";

const PURPOSES = ["agent_output", "user_upload"] as const;

/**
 * The files gallery (keyset "load more", cards or table) with its bar: the Files page's
 * (current space) and the overview's (every space). Visibility is the API's
 * (container-inherited ACL): members see the space's files, end-users only their own.
 */
export function FilesCollection({ spaceDefault }: { spaceDefault: SpaceDefault }) {
  const { t } = useTranslation(["files", "common"]);
  const list = useListParams(["purpose"]);
  const { spaceIds, scope } = useSpaceFilter(LIST_ADMITS.files, spaceDefault);
  const purposes = list.values("purpose", PURPOSES);
  const search = list.search;
  const canReach = useCanReach();
  const [view, setView] = useListView("documents");
  const searchPlaceholder = useSearchPlaceholder(t("common:nav.files"));
  const { usageLabel } = useOrgStorage();
  const query = useDebouncedValue(search);

  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useFilesPaged({
    search: query,
    purpose: purposes.length === 1 ? purposes[0] : undefined,
    spaceIds,
  });
  const files = useMemo(() => data?.pages.flatMap((page) => page.data) ?? [], [data]);

  const filtering = purposes.length > 0 || query.trim() !== "";
  const countLabel = hasNextPage
    ? t("page.countLoaded", { count: files.length })
    : t("page.count", { count: files.length });
  const footerLabel = usageLabel ? (
    <>
      {countLabel} <span aria-hidden>·</span> {t("storage.usage", { usage: usageLabel })}
    </>
  ) : (
    countLabel
  );

  return (
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
          scope={scope}
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
          ? { message: t("page.noMatch"), compact: true }
          : { message: t("page.empty"), hint: t("page.emptyHint") }
      }
      showRunLink={canReach("/agents/:scope/:name/runs/:runId")}
      spanning={spaceIds.length > 0}
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
  );
}
