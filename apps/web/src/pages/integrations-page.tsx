// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration catalogue.
 *
 *   - Unified list toolbar: search + facet filters (state, keywords) + sort +
 *     grid/list view toggle.
 *   - Per-card / row: an "Activé / Non activé" badge. Activation, per-auth
 *     connect, OAuth client registration and governance live on the detail
 *     page (`<IntegrationDetailPage />`).
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Boxes, Plus, Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState } from "../components/page-states";
import { RichEmptyState } from "../components/rich-empty-state";
import {
  ListToolbar,
  FilterButton,
  SortButton,
  type ViewMode,
  type ActiveChip,
  type FilterGroup,
} from "../components/list-toolbar";
import { useIntegrations, type IntegrationSummary } from "../hooks/use-integrations";
import { usePermissions } from "../hooks/use-permissions";

function matchesQuery(integration: IntegrationSummary, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const m = integration.manifest;
  return (
    integration.id.toLowerCase().includes(q) ||
    (m.display_name?.toLowerCase().includes(q) ?? false) ||
    (m.description?.toLowerCase().includes(q) ?? false) ||
    (m.keywords?.some((k) => k.toLowerCase().includes(q)) ?? false)
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useTranslation("settings");
  return active ? (
    <span className="bg-success-soft text-success rounded px-1.5 py-0.5 text-[0.65rem] font-semibold">
      {t("integrations.badge.active")}
    </span>
  ) : (
    <span className="bg-warning-soft text-warning rounded px-1.5 py-0.5 text-[0.65rem] font-semibold">
      {t("integrations.badge.inactive")}
    </span>
  );
}

function IntegrationIcon({ src, size = 40 }: { src?: string; size?: number }) {
  const [errored, setErrored] = useState(false);
  if (src && !errored) {
    return (
      <img
        src={src}
        alt=""
        style={{ width: size, height: size }}
        className="shrink-0 rounded-md object-contain"
        onError={() => setErrored(true)}
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size }}
      className="bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-md"
    >
      <Puzzle size={Math.round(size * 0.5)} />
    </div>
  );
}

function IntegrationCard({ integration }: { integration: IntegrationSummary }) {
  const m = integration.manifest;
  return (
    <Link
      to={`/integrations/${integration.id}`}
      data-testid="integration-card"
      data-integration-id={integration.id}
      className="border-border bg-card hover:border-foreground/20 flex flex-col rounded-[var(--radius)] border p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <IntegrationIcon src={m.icon} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{m.display_name ?? integration.id}</h3>
          <p className="text-muted-foreground truncate font-mono text-xs">{integration.id}</p>
        </div>
        <ActiveBadge active={Boolean(integration.active)} />
      </div>
      {m.description && (
        <p className="text-muted-foreground mt-3 line-clamp-2 text-sm">{m.description}</p>
      )}
    </Link>
  );
}

function IntegrationRow({ integration }: { integration: IntegrationSummary }) {
  const m = integration.manifest;
  return (
    <Link
      to={`/integrations/${integration.id}`}
      data-testid="integration-card"
      data-integration-id={integration.id}
      className="border-border/70 hover:bg-accent/50 grid min-h-[56px] grid-cols-[minmax(0,1fr)_96px] items-center gap-3 border-b px-4 transition-colors last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <IntegrationIcon src={m.icon} size={34} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{m.display_name ?? integration.id}</div>
          <div className="text-muted-foreground truncate font-mono text-xs">{integration.id}</div>
        </div>
      </div>
      <div className="text-muted-foreground hidden truncate text-xs sm:block">
        {m.description}
      </div>
      <div className="flex justify-end">
        <ActiveBadge active={Boolean(integration.active)} />
      </div>
    </Link>
  );
}

export function IntegrationsPage() {
  const { t } = useTranslation("settings");
  const { isAdmin } = usePermissions();
  const { data: integrations, isLoading, error } = useIntegrations();

  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>(
    () => (localStorage.getItem("intg.view") as ViewMode) || "grid",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Set<string>>(new Set());
  useEffect(() => {
    localStorage.setItem("intg.view", view);
  }, [view]);

  const toggleFilter = (id: string) =>
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const all = integrations ?? [];
  const allKeywords = Array.from(
    new Set(all.flatMap((i) => i.manifest.keywords ?? [])),
  ).sort();
  const stateSel = ["active", "inactive"].filter((s) => filters.has(s));
  const kwSel = [...filters].filter((f) => f.startsWith("kw:")).map((f) => f.slice(3));

  const list = all
    .filter((i) => {
      if (stateSel.length === 1) {
        if (stateSel[0] === "active" && !i.active) return false;
        if (stateSel[0] === "inactive" && i.active) return false;
      }
      if (kwSel.length > 0 && !kwSel.some((k) => i.manifest.keywords?.includes(k))) return false;
      return matchesQuery(i, query);
    })
    .sort((a, b) => {
      const r = (a.manifest.display_name ?? a.id).localeCompare(b.manifest.display_name ?? b.id);
      return sortDir === "asc" ? r : -r;
    });

  const activeLabel = t("integrations.badge.active");
  const inactiveLabel = t("integrations.badge.inactive");
  const filterGroups: FilterGroup[] = [
    {
      label: t("integrations.filterState", { defaultValue: "État" }),
      options: [
        { id: "active", label: activeLabel },
        { id: "inactive", label: inactiveLabel },
      ],
    },
    ...(allKeywords.length > 0
      ? [
          {
            label: t("filter.keywords", { defaultValue: "Mots-clés" }),
            options: allKeywords.map((k) => ({ id: `kw:${k}`, label: k })),
          },
        ]
      : []),
  ];
  const chipLabels: Record<string, string> = { active: activeLabel, inactive: inactiveLabel };
  const chips: ActiveChip[] = [...filters].map((id) => ({
    key: id,
    label: id.startsWith("kw:") ? id.slice(3) : (chipLabels[id] ?? id),
    onRemove: () => toggleFilter(id),
  }));

  return (
    <div className="mx-auto w-full max-w-[1300px] p-8 pb-16">
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-[1.6rem] font-bold tracking-tight">{t("integrations.title")}</h1>
          <span className="text-muted-foreground text-sm">
            {list.length} {t("integrations.title").toLowerCase()}
          </span>
        </div>
        <span className="flex-1" />
        {isAdmin && (
          <Button asChild>
            <Link to="/integrations/new">
              <Plus size={14} /> {t("integrations.create")}
            </Link>
          </Button>
        )}
      </div>
      <p className="text-muted-foreground mb-5 text-sm">{t("integrations.subtitle")}</p>

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={String(error)} />
      ) : all.length === 0 ? (
        <RichEmptyState
          icon={Boxes}
          title={t("integrations.empty.all")}
          description={t("integrations.subtitle")}
          action={
            isAdmin ? (
              <Button asChild>
                <Link to="/integrations/new">
                  <Plus className="size-4" /> {t("integrations.create")}
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ListToolbar
            q={query}
            onQ={setQuery}
            placeholder={t("integrations.search.placeholder")}
            view={view}
            onView={setView}
            filter={
              <FilterButton
                groups={filterGroups}
                selected={filters}
                onToggle={toggleFilter}
                onReset={() => setFilters(new Set())}
                label={t("filter.label", { defaultValue: "Filtrer" })}
              />
            }
            sort={
              <SortButton
                options={[{ id: "name", label: t("sort.name", { defaultValue: "Nom" }) }]}
                value="name"
                dir={sortDir}
                onChange={(_, d) => setSortDir(d)}
                labels={{
                  sortBy: t("sort.by", { defaultValue: "Trier" }),
                  asc: t("sort.asc", { defaultValue: "Croissant" }),
                  desc: t("sort.desc", { defaultValue: "Décroissant" }),
                }}
              />
            }
            chips={chips}
          />

          {list.length === 0 ? (
            <div className="border-border bg-card text-muted-foreground flex flex-col items-center gap-3 rounded-[var(--radius)] border p-12 text-center text-sm">
              <Boxes className="text-muted-foreground/50 size-6" />
              {t("integrations.empty.active")}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setFilters(new Set());
                }}
              >
                {t("list.resetSearch", { ns: "agents", defaultValue: "Réinitialiser" })}
              </Button>
            </div>
          ) : view === "grid" ? (
            <div
              className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
              data-testid="integration-grid"
            >
              {list.map((integration) => (
                <IntegrationCard key={integration.id} integration={integration} />
              ))}
            </div>
          ) : (
            <div
              className="border-border bg-card overflow-hidden rounded-[var(--radius)] border shadow-sm"
              data-testid="integration-grid"
            >
              {list.map((integration) => (
                <IntegrationRow key={integration.id} integration={integration} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
