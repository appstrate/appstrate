// SPDX-License-Identifier: Apache-2.0

import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SearchX } from "lucide-react";
import { runStatusValues } from "@appstrate/shared-types";
import { Button } from "@appstrate/ui/components/button";
import { useUnreadCount, useMarkAllRead } from "../hooks/use-notifications";
import { PageHeader } from "../components/page-header";
import { EmptyState } from "../components/page-states";
import { ListToolbar, type FilterSpec } from "../components/list-toolbar";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { RunList } from "../components/run-list";
import type { RunKindFilter } from "../hooks/use-paginated-runs";

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
function readList<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  return raw.split(",").filter((v): v is T => (allowed as readonly string[]).includes(v));
}

export function RunsPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { data: unreadCount } = useUnreadCount();
  const markAllRead = useMarkAllRead();
  const [params, setParams] = useSearchParams();
  const searchPlaceholder = useSearchPlaceholder(t("runs.entity"));

  const scopes = readList(params.get("user"), SCOPES);
  const kinds = readList(params.get("kind"), KINDS);
  const statuses = readList(params.get("status"), runStatusValues);
  const search = params.get("q") ?? "";

  // Pushed, not replaced: a filter is a place you went, and Back has to undo
  // it — the same obligation the URL brings everywhere else in this app.
  const setParam = (key: string) => (values: string[]) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (values.length === 0) next.delete(key);
      else next.set(key, values.join(","));
      return next;
    });
  };

  // ONE update, not one per dimension. Three `setParams` in the same tick each
  // read the same committed location, so the last would win and the other two
  // filters would survive a "Réinitialiser" that looked like it worked.
  const resetFilters = () =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const key of FILTER_PARAMS) next.delete(key);
      return next;
    });

  // The text filter is a URL parameter like the others, so a search is a link
  // too. Replaced rather than pushed: typing eight characters would otherwise
  // put eight entries in the history and make Back useless.
  const setSearch = (value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set("q", value);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );

  const filters: FilterSpec[] = [
    {
      id: "user",
      label: t("runs.filterScope"),
      values: scopes,
      options: [{ value: "me", label: t("runs.filterMine") }],
      onChange: setParam("user"),
    },
    {
      id: "kind",
      label: t("runs.filterKind"),
      values: kinds,
      options: [
        { value: "package", label: t("runs.filterKindPackage") },
        { value: "inline", label: t("runs.filterKindInline") },
      ],
      onChange: setParam("kind"),
    },
    {
      id: "status",
      label: t("runs.filterStatus"),
      values: statuses,
      options: runStatusValues.map((value) => ({
        value,
        label: t(`status.${value}`, { ns: "common" }),
      })),
      onChange: setParam("status"),
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
        toolbar={({ total, columns }) => (
          <ListToolbar
            search={{
              value: search,
              onChange: setSearch,
              placeholder: searchPlaceholder,
            }}
            filters={filters}
            onReset={resetFilters}
            count={t("runs.count", { count: total })}
            columns={columns}
            // On a list screen the action belongs beside the view controls,
            // not at title height: every table screen then keeps its controls
            // and its actions in the same corner.
            actions={
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => markAllRead.mutate({})}
                disabled={markAllRead.isPending || !unreadCount}
              >
                {t("runs.markAllRead")}
              </Button>
            }
          />
        )}
        // A filtered list that finds nothing has NOT run out of runs — it has
        // run out of matches, and the way out is the filter, not the agent.
        emptyState={
          search || filters.some((f) => f.values.length > 0) ? (
            <EmptyState message={t("runs.emptyFiltered")} icon={SearchX} compact>
              <Button variant="outline" size="sm" onClick={resetFilters}>
                {t("toolbar.clearAll", { ns: "common" })}
              </Button>
            </EmptyState>
          ) : undefined
        }
      />
    </div>
  );
}
