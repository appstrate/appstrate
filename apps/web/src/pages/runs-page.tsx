// SPDX-License-Identifier: Apache-2.0

import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SearchX } from "lucide-react";
import { runStatusValues } from "@appstrate/shared-types";
import { Button } from "@appstrate/ui/components/button";
import { EmptyState } from "../components/page-states";
import { useUnreadCount, useMarkAllRead } from "../hooks/use-notifications";
import { PageHeader } from "../components/page-header";
import { ListToolbar, type FilterSpec } from "../components/list-toolbar";
import { RunList } from "../components/run-list";
import type { RunKindFilter } from "../hooks/use-paginated-runs";

/**
 * The filters live in the URL, so a filtered list is a link. They also come
 * back as one closed set rather than two tab strips: three dimensions of
 * filtering drawn as tabs is three rows of chrome above five rows of data, and
 * `status` — which the API has always accepted — had nowhere to go at all.
 */
const KINDS: RunKindFilter[] = ["package", "inline"];

export function RunsPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { data: unreadCount } = useUnreadCount();
  const markAllRead = useMarkAllRead();
  const [params, setParams] = useSearchParams();

  const scope = params.get("user") === "me" ? "me" : undefined;
  const kind = KINDS.find((k) => k === params.get("kind"));
  const status = runStatusValues.find((s) => s === params.get("status"));

  // Pushed, not replaced: a filter is a place you went, and Back has to undo
  // it — the same obligation the URL brings everywhere else in this app.
  const setParam = (key: string) => (value?: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === undefined) next.delete(key);
      else next.set(key, value);
      return next;
    });
  };

  const filters: FilterSpec[] = [
    {
      id: "user",
      label: t("runs.filterScope"),
      value: scope,
      options: [{ value: "me", label: t("runs.filterMine") }],
      onChange: setParam("user"),
    },
    {
      id: "kind",
      label: t("runs.filterKind"),
      value: kind,
      options: [
        { value: "package", label: t("runs.filterKindPackage") },
        { value: "inline", label: t("runs.filterKindInline") },
      ],
      onChange: setParam("kind"),
    },
    {
      id: "status",
      label: t("runs.filterStatus"),
      value: status,
      options: runStatusValues.map((value) => ({
        value,
        label: t(`status.${value}`, { ns: "common" }),
      })),
      onChange: setParam("status"),
    },
  ];

  return (
    <div>
      {/* The page's action stays at title height, where every other screen
          keeps its own — the toolbar below is about the list, not the page. */}
      <PageHeader
        title={t("runs.title")}
        emoji="▶️"
        breadcrumbs={[{ label: t("runs.title") }]}
        actions={
          <Button
            variant="outline"
            onClick={() => markAllRead.mutate({})}
            disabled={markAllRead.isPending || !unreadCount}
          >
            {t("runs.markAllRead")}
          </Button>
        }
      />

      {/* Keyed on the filters: a changed filter starts again at page one, and
          the previous page's rows do not flash under the new query. */}
      <RunList
        key={`${scope}-${kind}-${status}`}
        pageSize={15}
        user={scope}
        kind={kind}
        status={status}
        toolbar={(total) => (
          <ListToolbar filters={filters} count={t("runs.count", { count: total })} />
        )}
        // A filtered list that finds nothing has NOT run out of runs — it has
        // run out of matches, and the way out is the filter, not the agent.
        emptyState={
          filters.some((f) => f.value !== undefined) ? (
            <EmptyState message={t("runs.emptyFiltered")} icon={SearchX} compact>
              {/* The same clear the chips use: wiping the whole query string
                  would take any other parameter the page grows with it. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => filters.forEach((f) => f.onChange(undefined))}
              >
                {t("toolbar.clearAll", { ns: "common" })}
              </Button>
            </EmptyState>
          ) : undefined
        }
      />
    </div>
  );
}
