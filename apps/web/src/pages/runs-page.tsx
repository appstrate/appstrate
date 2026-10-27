// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { CheckCheck } from "lucide-react";
import { useUnreadCount, useMarkAllRead } from "../hooks/use-notifications";
import { PageHeader } from "../components/page-header";
import { NoMatchState } from "../components/page-states";
import { ListToolbar, type FilterSpec } from "../components/list-toolbar";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useListParams } from "../lib/list-params";
import { RunList } from "../components/run-list";
import { PageActionsMenu } from "../components/page-actions-menu";
import type { RunKindFilter } from "../hooks/use-paginated-runs";
import { usePermissions } from "../hooks/use-permissions";
import { useRunStatusFilter } from "../hooks/use-run-status-filter";

/**
 * Filters live in the URL (a filtered list is a link) and each takes SEVERAL
 * values. Kind and scope are narrower on the wire: squaring that with the
 * checkboxes is this file's job, so a tick means a tick on every menu.
 */
const KINDS = ["package", "inline"] as const;
const SCOPES = ["me"] as const;

/** The query parameters this screen filters on, and nothing else. */
const FILTER_PARAMS = ["user", "kind", "status", "q"] as const;

/** `?status=failed,timeout` — the wire shape the endpoint takes. */
export function RunsPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { data: unreadCount } = useUnreadCount();
  const markAllRead = useMarkAllRead();
  const list = useListParams(FILTER_PARAMS);
  const searchPlaceholder = useSearchPlaceholder(t("common:nav.runs"));
  const { can } = usePermissions();
  // Without `runs:read-all` the list is already "mine": no scope filter.
  const canSeeEveryRun = can("runs:read-all");

  const scopes = list.values("user", SCOPES);
  const kinds = list.values("kind", KINDS);
  const { statuses, filter: statusFilter } = useRunStatusFilter(list);
  const search = list.search;

  const filters: FilterSpec[] = [
    ...(canSeeEveryRun
      ? [
          {
            id: "user",
            label: t("runs.filterScope"),
            values: scopes,
            options: [{ value: "me", label: t("runs.filterMine") }],
            onChange: list.setValues("user"),
          },
        ]
      : []),
    {
      id: "kind",
      label: t("runs.filterKind"),
      values: kinds,
      options: [
        { value: "package", label: t("common:nav.agents") },
        { value: "inline", label: t("runs.inlineBadge") },
      ],
      onChange: list.setValues("kind"),
    },
    statusFilter,
  ];

  // The endpoint takes ONE kind, so "both ticked" is "no kind parameter" (same
  // for scope); the ticks themselves stay as ticked.
  const kind: RunKindFilter | undefined = kinds.length === 1 ? kinds[0] : undefined;
  const user = canSeeEveryRun && scopes.includes("me") ? "me" : undefined;

  return (
    <div>
      <PageHeader
        title={t("runs.title")}
        variant="collection"
        breadcrumbs={[{ label: t("runs.title") }]}
        actions={
          <PageActionsMenu
            actions={[
              {
                id: "mark-all-read",
                label: t("common:notifications.markAllRead"),
                icon: CheckCheck,
                onSelect: () => markAllRead.mutate({}),
                disabled: markAllRead.isPending || !unreadCount,
              },
            ]}
          />
        }
      />

      <RunList
        pageSize={15}
        user={user}
        kind={kind}
        status={statuses}
        search={search}
        countLabel={(total) => t("runs.count", { count: total })}
        toolbar={({ columns }) => (
          <ListToolbar
            search={{
              value: search,
              onChange: list.setSearch,
              placeholder: searchPlaceholder,
            }}
            filters={filters}
            onReset={list.reset}
            columns={columns}
          />
        )}
        // A filtered list that finds nothing ran out of matches: the way out is the filter.
        emptyState={
          search || filters.some((f) => f.values.length > 0) ? (
            <NoMatchState message={t("runs.emptyFiltered")} onReset={list.reset} />
          ) : undefined
        }
      />
    </div>
  );
}
