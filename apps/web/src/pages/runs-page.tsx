// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { CheckCheck, SearchX } from "lucide-react";
import { runStatusValues } from "@appstrate/shared-types";
import { Button } from "@appstrate/ui/components/button";
import { useUnreadCount, useMarkAllRead } from "../hooks/use-notifications";
import { PageHeader } from "../components/page-header";
import { EmptyState } from "../components/page-states";
import { ListToolbar, type FilterSpec } from "../components/list-toolbar";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useListParams } from "../lib/list-params";
import { TOOLBAR_ACTION } from "../lib/toolbar-button";
import { RunList } from "../components/run-list";
import type { RunKindFilter } from "../hooks/use-paginated-runs";
import { useRunViewStore } from "../stores/list-view-store";

/**
 * The filters live in the URL, so a filtered list is a link. They also come
 * back as one closed set rather than two tab strips: three dimensions drawn as
 * tabs is three rows of chrome above five rows of data, and `status` — which
 * the API has always accepted — had nowhere to go at all.
 *
 * Each dimension takes SEVERAL values. It matters for one of them: "everything
 * that broke" is `failed` or `timeout`, one question the endpoint now answers
 * in one request. The other two are narrower on the wire, and squaring that
 * with the checkboxes is THIS file's job, not the toolbar's — a tick has to
 * mean a tick on every menu.
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
  const searchPlaceholder = useSearchPlaceholder(t("runs.entity"));

  const scopes = list.values("user", SCOPES);
  const kinds = list.values("kind", KINDS);
  const statuses = list.values("status", runStatusValues);
  const search = list.search;
  const view = useRunViewStore((state) => state.view);
  const setView = useRunViewStore((state) => state.setView);

  const filters: FilterSpec[] = [
    {
      id: "user",
      label: t("runs.filterScope"),
      values: scopes,
      options: [{ value: "me", label: t("runs.filterMine") }],
      onChange: list.setValues("user"),
    },
    {
      id: "kind",
      label: t("runs.filterKind"),
      values: kinds,
      options: [
        { value: "package", label: t("runs.filterKindPackage") },
        { value: "inline", label: t("runs.filterKindInline") },
      ],
      onChange: list.setValues("kind"),
    },
    {
      id: "status",
      label: t("runs.filterStatus"),
      values: statuses,
      options: runStatusValues.map((value) => ({
        value,
        label: t(`status.${value}`, { ns: "common" }),
      })),
      onChange: list.setValues("status"),
    },
  ];

  // The endpoint takes ONE kind, so "both ticked" is spelled "no kind
  // parameter" — the same rows, asked for in the only way the wire has. Same
  // for scope, whose single box is on or off. Neither collapses the ticks
  // themselves: what you ticked stays ticked and stays chipped.
  const kind: RunKindFilter | undefined = kinds.length === 1 ? kinds[0] : undefined;
  const user = scopes.includes("me") ? "me" : undefined;

  return (
    <div>
      <PageHeader title={t("runs.title")} emoji="▶️" breadcrumbs={[{ label: t("runs.title") }]} />

      <RunList
        pageSize={15}
        user={user}
        kind={kind}
        status={statuses}
        search={search}
        view={view}
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
            columns={view === "table" ? columns : undefined}
            view={view}
            onViewChange={setView}
            // On a list screen the action belongs beside the view controls,
            // not at title height: every table screen then keeps its controls
            // and its actions in the same corner.
            // The icon is what survives when the bar runs out of room; the
            // words step aside on `@lg/bar`, the container the toolbar names.
            actions={
              <Button
                variant="outline"
                size="sm"
                className={TOOLBAR_ACTION}
                title={t("runs.markAllRead")}
                onClick={() => markAllRead.mutate({})}
                disabled={markAllRead.isPending || !unreadCount}
              >
                <CheckCheck />
                <span className="hidden @lg/bar:inline">{t("runs.markAllRead")}</span>
              </Button>
            }
          />
        )}
        // A filtered list that finds nothing has NOT run out of runs — it has
        // run out of matches, and the way out is the filter, not the agent.
        emptyState={
          search || filters.some((f) => f.values.length > 0) ? (
            <EmptyState message={t("runs.emptyFiltered")} icon={SearchX} compact>
              <Button variant="outline" size="sm" onClick={list.reset}>
                {t("toolbar.clearAll", { ns: "common" })}
              </Button>
            </EmptyState>
          ) : undefined
        }
      />
    </div>
  );
}
