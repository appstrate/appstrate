// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { type LucideIcon, Layers, ShieldCheck } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAgents } from "../hooks/use-packages";
import { useUnreadCountsByAgent } from "../hooks/use-notifications";
import { PackageCard } from "../components/package-card";
import { Badge } from "../components/status-badge";
import { RunAgentButton } from "../components/run-agent-button";
import {
  ListToolbar,
  FilterButton,
  SortButton,
  type ViewMode,
  type ActiveChip,
  type FilterGroup,
} from "../components/list-toolbar";
import { PageHeader, type BreadcrumbEntry } from "../components/page-header";
import { ImportModal } from "../components/import-modal";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { RichEmptyState } from "../components/rich-empty-state";
import { usePermissions } from "../hooks/use-permissions";

const TINTS = [
  "bg-primary-soft text-primary",
  "bg-spark-soft text-spark",
  "bg-success-soft text-success",
  "bg-warning-soft text-warning",
];
function tintFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

export interface CardItem {
  id: string;
  displayName: string;
  description?: string | null;
  type: PackageType;
  source?: "system" | "local";
  runningRuns?: number;
  keywords?: string[];
  usedByAgents?: number;
  unreadCount?: number;
  actions?: ReactNode;
  autoInstalled?: boolean;
}

interface PackageTabProps {
  title?: string;
  emoji?: string;
  breadcrumbs?: BreadcrumbEntry[];
  items: CardItem[] | undefined;
  isLoading: boolean;
  error?: Error | null;
  emptyMessage: string;
  emptyHint: ReactNode;
  emptyIcon: LucideIcon;
  extraActions?: ReactNode;
  emptyExtraActions?: ReactNode;
  headerContent?: ReactNode;
}

export function PackageTab({
  title,
  emoji,
  breadcrumbs,
  items,
  isLoading,
  error,
  emptyMessage,
  emptyHint,
  emptyIcon,
  extraActions,
  emptyExtraActions,
  headerContent,
}: PackageTabProps) {
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const header = title ? (
    <PageHeader title={title} emoji={emoji} breadcrumbs={breadcrumbs} actions={extraActions}>
      {headerContent}
    </PageHeader>
  ) : null;

  const emptyActions = emptyExtraActions !== undefined ? emptyExtraActions : extraActions;

  if (!items || items.length === 0) {
    return (
      <>
        {header}
        <EmptyState message={emptyMessage} hint={emptyHint} icon={emptyIcon}>
          {emptyActions}
        </EmptyState>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {items.map((item) => (
          <PackageCard key={item.id} {...item} />
        ))}
      </div>
    </>
  );
}

function AgentTableRow({ item, systemLabel }: { item: CardItem; systemLabel: string }) {
  const running = !!item.runningRuns && item.runningRuns > 0;
  return (
    <Link
      to={`/agents/${item.id}`}
      className="border-border/70 hover:bg-accent/50 grid min-h-[56px] grid-cols-[minmax(0,1fr)_56px] items-center gap-3 border-b px-4 transition-colors last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,220px)_56px]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-[9px]",
            tintFor(item.id),
          )}
        >
          <Layers className="size-[17px]" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{item.displayName}</span>
            {item.source === "system" && (
              <span className="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[0.6rem] font-semibold">
                <ShieldCheck className="size-2.5" /> {systemLabel}
              </span>
            )}
          </div>
          {item.description && (
            <div className="text-muted-foreground truncate text-xs">{item.description}</div>
          )}
        </div>
      </div>
      <div className="hidden min-w-0 flex-wrap gap-1 sm:flex">
        {item.keywords?.slice(0, 3).map((kw) => (
          <span
            key={kw}
            className="bg-background text-muted-foreground border-border rounded-full border px-2 py-[0.1rem] text-[0.7rem]"
          >
            {kw}
          </span>
        ))}
      </div>
      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
        {running ? (
          <Badge status="running" />
        ) : (
          <RunAgentButton
            packageId={item.id}
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-primary size-7"
          />
        )}
      </div>
    </Link>
  );
}

export function PackageList() {
  const { t } = useTranslation(["agents", "common"]);
  const { data: agents, isLoading, error } = useAgents();
  const { data: unreadCounts } = useUnreadCountsByAgent();
  const { isAdmin } = usePermissions();
  const [importOpen, setImportOpen] = useState(false);
  const [q, setQ] = useState("");
  const [view, setView] = useState<ViewMode>(
    () => (localStorage.getItem("agents.view") as ViewMode) || "grid",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Set<string>>(new Set());
  useEffect(() => {
    localStorage.setItem("agents.view", view);
  }, [view]);

  const items: CardItem[] = (agents ?? []).map((f) => ({
    id: f.id,
    displayName: f.display_name,
    description: f.description,
    type: "agent",
    source: f.source,
    runningRuns: f.running_runs,
    keywords: f.keywords,
    unreadCount: unreadCounts?.[f.id],
  }));

  const toggleFilter = (id: string) =>
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const query = q.trim().toLowerCase();
  const sourceSel = ["local", "system"].filter((s) => filters.has(s));
  const kwSel = [...filters].filter((f) => f.startsWith("kw:")).map((f) => f.slice(3));
  const allKeywords = Array.from(new Set(items.flatMap((i) => i.keywords ?? []))).sort();
  const list = items
    .filter((i) => {
      if (filters.has("running") && !(i.runningRuns && i.runningRuns > 0)) return false;
      if (sourceSel.length > 0 && !sourceSel.includes(i.source ?? "")) return false;
      if (kwSel.length > 0 && !kwSel.some((k) => (i.keywords ?? []).includes(k))) return false;
      if (
        query &&
        !(
          i.displayName.toLowerCase().includes(query) ||
          (i.description ?? "").toLowerCase().includes(query) ||
          (i.keywords ?? []).some((k) => k.toLowerCase().includes(query))
        )
      )
        return false;
      return true;
    })
    .sort((a, b) => {
      const r = a.displayName.localeCompare(b.displayName);
      return sortDir === "asc" ? r : -r;
    });

  const systemLabel = t("filter.system", { defaultValue: "Système" });
  const filterGroups: FilterGroup[] = [
    {
      label: t("filter.state", { defaultValue: "État" }),
      options: [{ id: "running", label: t("filter.running", { defaultValue: "En cours" }) }],
    },
    {
      label: t("filter.source", { defaultValue: "Source" }),
      options: [
        { id: "local", label: t("filter.local", { defaultValue: "Local" }) },
        { id: "system", label: systemLabel },
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
  const chipLabels: Record<string, string> = {
    running: t("filter.running", { defaultValue: "En cours" }),
    local: t("filter.local", { defaultValue: "Local" }),
    system: systemLabel,
  };
  const chips: ActiveChip[] = [...filters].map((id) => ({
    key: id,
    label: id.startsWith("kw:") ? id.slice(3) : (chipLabels[id] ?? id),
    onRemove: () => toggleFilter(id),
  }));

  const actions = isAdmin ? (
    <>
      <Button variant="outline" onClick={() => setImportOpen(true)}>
        {t("nav.import", { ns: "common" })}
      </Button>
      <Button asChild>
        <Link to="/agents/new">{t("list.create")}</Link>
      </Button>
    </>
  ) : null;

  return (
    <div className="mx-auto w-full max-w-[1300px] p-8 pb-16">
      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error.message} />
      ) : (
        <>
          {/* Page head */}
          <div className="mb-5 flex flex-wrap items-center gap-4">
            <div className="flex items-baseline gap-2.5">
              <h1 className="text-[1.6rem] font-bold tracking-tight">{t("list.tabAgents")}</h1>
              <span className="text-muted-foreground text-sm">
                {list.length} {t("list.tabAgents").toLowerCase()}
              </span>
            </div>
            <span className="flex-1" />
            {actions && <div className="flex items-center gap-2">{actions}</div>}
          </div>

          {items.length === 0 ? (
            <RichEmptyState
              icon={Layers}
              title={t("list.empty")}
              description={<Trans t={t} i18nKey="list.emptyHint" components={{ 1: <code /> }} />}
              action={actions}
            />
          ) : (
            <>
              <ListToolbar
                q={q}
                onQ={setQ}
                placeholder={t("search.placeholder", { ns: "common", defaultValue: "Rechercher…" })}
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
                  <Layers className="text-muted-foreground/50 size-6" />
                  {t("list.noMatch", { defaultValue: "Aucun agent ne correspond." })}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQ("");
                      setFilters(new Set());
                    }}
                  >
                    {t("list.resetSearch", { defaultValue: "Réinitialiser" })}
                  </Button>
                </div>
              ) : view === "grid" ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((item) => (
                    <PackageCard key={item.id} {...item} />
                  ))}
                </div>
              ) : (
                <div className="border-border bg-card overflow-hidden rounded-[var(--radius)] border shadow-sm">
                  {list.map((item) => (
                    <AgentTableRow key={item.id} item={item} systemLabel={systemLabel} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
