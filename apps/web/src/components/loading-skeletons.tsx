// SPDX-License-Identifier: Apache-2.0

/**
 * Data on its way, drawn where it will be and in its shape. The page's frame
 * (header, toolbar, tabs) never waits on a read it does not show; whatever does
 * wait is grey blocks laid out as the content will be. A spinner is a control
 * at work, never content on its way.
 *
 * A route's fallback (`skeletonOf` in `app.tsx`) is the same skeleton its page
 * draws while loading, so the chunk and the data wait under one shape.
 */

import { ConversationSkeleton } from "@appstrate/module-chat/conversation-skeleton";
import { Card } from "@appstrate/ui/components/card";
import { CardList } from "./card-list";
import { PackageCardSkeleton } from "./package-card";
import { AgentOverviewSkeleton } from "./agent-detail/agent-overview-tab";
import { PackageOverviewSkeleton } from "./package-detail/package-overview";
import { IntegrationOverviewSkeleton } from "./package-detail/integration-overview";
import { ScheduleOverviewSkeleton } from "./schedule-overview-skeleton";
import { RunOverviewSkeleton } from "./run-detail/run-snapshot-inspector";
import { SkeletonBadge, SkeletonLine } from "./skeleton-line";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { PackageType } from "@appstrate/core/validation";
import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { usePageBreadcrumb } from "../hooks/use-overlay-breadcrumb";
import type { BreadcrumbEntry } from "../stores/breadcrumb-store";
import { useCurrentOrgId } from "../hooks/use-org";
import { usePermissions } from "../hooks/use-permissions";
import { useListView } from "../stores/list-view-store";
import { CardGridSkeleton } from "./card-grid";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { agentsKeys, packageKeys } from "../lib/query-keys";
import { usePackageListCrumb } from "../hooks/use-package-list-crumb";
import { DetailBarSkeleton } from "./detail-bar";

/** One `status` for assistive technology; the blocks themselves are hidden from it. */
export function Waiting({ className, children }: { className?: string; children: ReactNode }) {
  const { t } = useTranslation("common");
  return (
    <div role="status" aria-busy="true" aria-label={t("loading")} className={className}>
      <div aria-hidden className="contents">
        {children}
      </div>
    </div>
  );
}

const NO_CRUMBS: BreadcrumbEntry[] = [];

const LINE_WIDTHS = ["w-full", "w-11/12", "w-4/5", "w-full", "w-3/4"];

function Lines({ lines }: { lines: number }) {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3.5", i === lines - 1 && lines > 1 ? "w-2/5" : LINE_WIDTHS[i % 5])}
        />
      ))}
    </div>
  );
}

/** A block of text, a panel or a modal body whose content is prose or a short list. */
export function TextSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <Waiting className={className}>
      <Lines lines={lines} />
    </Waiting>
  );
}

/**
 * `PageHeader`'s box on a collection page: the same height, so the real title
 * replaces it in place. Publishes the part of the trail the page already knows
 * from its address.
 */
function HeaderBlocks({ breadcrumbs }: { breadcrumbs: BreadcrumbEntry[] }) {
  usePageBreadcrumb(breadcrumbs);
  return (
    <div data-page-header className="mb-4">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-8 w-24 shrink-0" />
      </div>
    </div>
  );
}

function CardBlocks({ count }: { count: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-4 rounded-lg border p-4">
          <Skeleton className="h-4 w-24" />
          <Lines lines={3} />
        </div>
      ))}
    </div>
  );
}

/**
 * A resource's page: its identity, controls and tabs are in the shell header
 * (`DetailBar`), so the page waits with its panel alone. Each detail route draws
 * the same element as its fallback and as its page's loading state, so the two
 * waits share one shape. `title` is drawn as text when known; `trail` is the
 * part of the header's trail the address already tells.
 */
export function DetailPageSkeleton({
  title,
  trail,
  tabCount,
  panel,
  meta,
}: {
  title?: string;
  trail?: readonly BreadcrumbEntry[];
  tabCount: number;
  /** Whether the page draws a line under its title (`DetailBarSkeleton`). */
  meta?: boolean;
  /** The first tab's own skeleton, when the page has one; generic blocks otherwise. */
  panel?: ReactNode;
}) {
  return (
    <Waiting>
      <DetailBarSkeleton title={title} trail={trail} tabCount={tabCount} meta={meta} />
      {/* `DetailTabPanel`'s frame. */}
      <Card className="overflow-hidden p-6 shadow-sm">{panel ?? <CardBlocks count={3} />}</Card>
    </Waiting>
  );
}

/** The name the family's list already holds for this package, when it was read. */
function useCachedPackageName(type: PackageType, packageId: string | undefined) {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  if (!packageId) return undefined;
  if (type === "agent") {
    return qc
      .getQueryData<{ id: string; display_name?: string }[]>(agentsKeys.list(orgId, spaceId))
      ?.find((row) => row.id === packageId)?.display_name;
  }
  return qc
    .getQueryData<{ id: string; name?: string }[]>(
      packageKeys.list(PACKAGE_TYPE_ROUTE_SEGMENT[type], orgId, spaceId),
    )
    ?.find((row) => row.id === packageId)?.name;
}

/**
 * A package's page while its detail loads (and its route's fallback): its
 * family's list as the parent, and its name when the list was read on the way here.
 */
export function PackageDetailSkeleton({ type }: { type: PackageType }) {
  const { scope, name } = useParams();
  const packageId = scope && name ? `${scope}/${name}` : undefined;
  const listCrumb = usePackageListCrumb(type);
  const title = useCachedPackageName(type, packageId);
  return (
    <DetailPageSkeleton
      title={title}
      trail={[listCrumb]}
      // An agent offers four tabs, every other family three.
      tabCount={type === "agent" ? 4 : 3}
      panel={
        type === "agent" ? (
          <AgentOverviewSkeleton />
        ) : type === "integration" ? (
          <IntegrationOverviewSkeleton />
        ) : (
          <PackageOverviewSkeleton type={type} />
        )
      }
    />
  );
}

/** A run's page, under its agent. */
export function RunDetailSkeleton({ agentName }: { agentName?: string }) {
  const { scope, name } = useParams();
  const listCrumb = usePackageListCrumb("agent");
  return (
    <DetailPageSkeleton
      trail={
        agentName
          ? [listCrumb, { label: agentName, href: `/agents/${scope}/${name}#runs` }]
          : [listCrumb]
      }
      tabCount={3}
      meta={false}
      panel={<RunOverviewSkeleton />}
    />
  );
}

/** A schedule's page, under the schedules list. */
export function ScheduleDetailSkeleton() {
  const { t } = useTranslation("agents");
  return (
    <DetailPageSkeleton
      trail={[{ label: t("common:nav.schedules"), href: "/schedules" }]}
      tabCount={3}
      meta={false}
      panel={<ScheduleOverviewSkeleton />}
    />
  );
}

/**
 * A collection page: title, toolbar, then the table's frame with its header and rows — or the
 * card grid, when `list` names a screen the reader (or its default) shows as cards.
 */
export function ListPageSkeleton({ list }: { list?: string }) {
  return (
    <Waiting>
      <HeaderBlocks breadcrumbs={NO_CRUMBS} />
      {list ? <ViewedCollectionBlocks list={list} /> : <CollectionBlocks />}
    </Waiting>
  );
}

function ViewedCollectionBlocks({ list }: { list: string }) {
  const [view] = useListView(list);
  return <CollectionBlocks cards={view === "cards"} runnable={list === "agent"} />;
}

/** A collection under its title: `ListToolbar`, then `DataTable`'s frame, head and rows. */
function CollectionBlocks({
  cards = false,
  runnable = false,
}: {
  cards?: boolean;
  /** The cards carry a run button (agents). */
  runnable?: boolean;
}) {
  return (
    <>
      {/* `ListToolbar`: an `h-8` search of at most 280px, then its filter button. */}
      <div className="mb-3 flex items-center gap-2">
        <Skeleton className="h-8 min-w-40 flex-1 sm:max-w-[280px]" />
        <Skeleton className="h-8 w-20" />
      </div>
      {cards ? (
        <CardGridSkeleton placeholder={<PackageCardSkeleton runnable={runnable} />} />
      ) : (
        <Card className="overflow-hidden">
          <div className="border-border flex h-10 items-center border-b px-3">
            <Skeleton className="h-3 w-1/3" />
          </div>
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="border-border/60 flex h-12 items-center border-b px-3 last:border-b-0"
            >
              <Skeleton className="h-3.5 w-full" />
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

/**
 * A settings page or section: `SettingRow`s, label over description over control, each bar in a
 * box of its line's height (`text-sm`, then `mt-1 text-xs leading-relaxed`, then an `h-10` field)
 * so the rows that replace them stand where they did.
 */
export function SettingsSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <Waiting className={className}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="pb-8 last:pb-0">
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-36" />
          </div>
          <div className="mt-1 flex h-[1.21875rem] items-center">
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
          <Skeleton className="mt-3 h-10 w-full max-w-md" />
        </div>
      ))}
    </Waiting>
  );
}

/**
 * A package's definition editor while its code loads: `PackageEditorFrame`'s padded column, its
 * section heading, then the section's rows.
 */
export function EditorPanelSkeleton() {
  return (
    <Waiting className="flex flex-1 flex-col gap-4 p-6">
      <div className="mb-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="mt-1.5 h-4 w-80 max-w-full" />
      </div>
      <SettingsSkeleton />
    </Waiting>
  );
}

/**
 * A settings page that is a table (`DataTable` on the panel's integrated surface: no frame, the
 * head ruled above and below), with the list's toolbar when it has one.
 */
export function SettingsTableSkeleton({ toolbar = false }: { toolbar?: boolean }) {
  return (
    <Waiting>
      {toolbar && (
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="h-8 min-w-40 flex-1 sm:max-w-[280px]" />
          <Skeleton className="h-8 w-20" />
        </div>
      )}
      <div className="border-border flex h-10 items-center border-y px-3">
        <Skeleton className="h-3 w-1/3" />
      </div>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="border-border/60 flex h-12 items-center border-b px-3">
          <Skeleton className="h-3.5 w-full" />
        </div>
      ))}
    </Waiting>
  );
}

/**
 * The editor's own box, drawn as text lines: the same block waits for the data
 * and for the lazy chunk, so the editor replaces it in place.
 */
export function EditorSkeleton({ height }: { height?: string | number }) {
  return (
    <div className="overflow-hidden" style={{ height: height ?? "300px" }}>
      <TextSkeleton lines={8} className="p-4" />
    </div>
  );
}

/** A form page with its title in the shell header and no tabs (the MCP URL wizard). */
export function FormPageSkeleton() {
  return (
    <Waiting>
      <DetailBarSkeleton tabCount={0} />
      <SettingsSkeleton rows={4} />
    </Waiting>
  );
}

/** `SectionHeading` of the dashboard: its `<h2>` and its link. */
function DashboardSectionHeadingSkeleton() {
  return (
    <div className="mb-3 flex items-center justify-between gap-4">
      <SkeletonLine className="w-36 text-base font-semibold" />
      <SkeletonLine className="w-20 text-xs font-medium" />
    </div>
  );
}

/** The dashboard's `MetricCard`: label, figure, detail. */
function MetricCardSkeleton() {
  return (
    <Card className="flex min-h-32 flex-col justify-between rounded-xl p-4">
      <SkeletonLine className="w-20 text-xs font-medium" />
      <div>
        <SkeletonLine className="w-12 text-3xl font-semibold" />
        <SkeletonLine className="mt-1 w-32 text-xs" />
      </div>
    </Card>
  );
}

/** `RunRow`: icon, agent and date, status badge, duration. */
function RunRowSkeleton() {
  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <Skeleton className="size-8 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        <SkeletonLine className="w-40 text-sm font-medium" />
        <SkeletonLine className="mt-0.5 w-28 text-xs" />
      </div>
      {/* `RunStatusBadge`'s own wrapper: its line box makes the row's badge column taller than the badge. */}
      <span className="relative shrink-0">
        <SkeletonBadge className="w-16" />
      </span>
      <SkeletonLine className="w-14 text-xs" />
    </div>
  );
}

/** The dashboard's schedule row: icon, label and agent, state badge and next run. */
function ScheduleRowSkeleton() {
  return (
    <div className="flex min-h-[74px] items-center gap-3 px-4 py-3">
      <Skeleton className="size-9 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        <SkeletonLine className="w-36 text-sm font-medium" />
        <SkeletonLine className="mt-0.5 w-24 text-xs" />
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <SkeletonBadge className="w-14" />
        <SkeletonLine className="mt-1 w-24 text-[11px]" />
      </div>
    </div>
  );
}

/**
 * The dashboard below its greeting: the figures, recent agents, the two lists —
 * each block built like the component it stands for, in the same layout
 * (`DashboardContent`), so nothing moves when the data lands. Recent runs at
 * their cap (`RecentRuns`, 7); schedules at two, their count being the data's.
 */
export function DashboardBodySkeleton() {
  return (
    <Waiting className="flex flex-col gap-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <MetricCardSkeleton key={i} />
        ))}
      </div>
      <div>
        <DashboardSectionHeadingSkeleton />
        <div className="flex gap-3 overflow-hidden pb-1">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="w-[19rem] shrink-0">
              <PackageCardSkeleton runnable />
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.8fr)]">
        <div className="min-w-0">
          <DashboardSectionHeadingSkeleton />
          <CardList>
            {Array.from({ length: 7 }, (_, i) => (
              <RunRowSkeleton key={i} />
            ))}
          </CardList>
        </div>
        <div className="min-w-0">
          <DashboardSectionHeadingSkeleton />
          <CardList>
            {Array.from({ length: 2 }, (_, i) => (
              <ScheduleRowSkeleton key={i} />
            ))}
          </CardList>
        </div>
      </div>
    </Waiting>
  );
}

/** A panel page's title row (`settings/layout.tsx`): `mb-6 min-h-9` around an `text-xl` title. */
export function PanelTitleBlock() {
  return (
    <div className="mb-6 flex min-h-9 items-center" aria-hidden>
      <Skeleton className="h-6 w-48" />
    </div>
  );
}

/**
 * The panes of a routed overlay (settings, catalogue) whose code is not loaded
 * yet: `PanelLayout`'s rail and page as blocks. Content only — the dialog around
 * it is `OverlayFrame`'s and is already open, so the page replaces this inside
 * the same box instead of opening a second one. Reached only on a cold address,
 * since the shell preloads the overlays on intent.
 */
export function OverlayPanelSkeleton({ list }: { list?: boolean }) {
  return (
    <>
      <aside className="bg-sidebar border-sidebar-border flex w-56 shrink-0 flex-col gap-2 border-r p-3 max-md:hidden">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </aside>
      {/* `PanelLayout`'s pane: its band (`py-3` around a `min-h-8` line) leaves 57px above the
          page, whose title row is `mb-6 min-h-9`. */}
      <div className="min-w-0 flex-1 p-6 pt-[57px]">
        <PanelTitleBlock />
        {list ? (
          <Waiting>
            <CollectionBlocks />
          </Waiting>
        ) : (
          <SettingsSkeleton />
        )}
      </div>
    </>
  );
}

/**
 * The chat's composer (`module-chat` `Composer`): a `min-h-9` line over its tool row, in a card
 * of the thread's width.
 */
function ComposerBlock() {
  return (
    <div className="bg-card flex w-full flex-col gap-1 rounded-xl border px-3 py-2 shadow-sm">
      <div className="flex min-h-9 items-center py-1">
        <Skeleton className="h-3.5 w-48" />
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="h-7 w-32 rounded-md" />
        </div>
        <Skeleton className="size-8 rounded-lg" />
      </div>
    </div>
  );
}

/**
 * `/chat` while its code loads: `ThreadWelcome` — the title and hint, the composer, then the
 * suggestions (a writer's only), centred in the thread's 42rem column. The module's own wait for
 * a stored conversation is {@link ChatConversationSkeleton}'s shape.
 */
export function ChatPanelSkeleton() {
  const canWrite = usePermissions().can("chat:write");
  return (
    <Waiting className="flex h-full flex-col items-center justify-center px-4">
      <div className="flex w-full max-w-2xl flex-col items-stretch gap-6">
        <div className="flex flex-col items-center">
          <div className="flex h-7 items-center">
            <Skeleton className="h-5 w-40" />
          </div>
          <div className="mt-1 flex h-5 items-center">
            <Skeleton className="h-3.5 w-72 max-w-full" />
          </div>
        </div>
        {canWrite ? (
          <>
            <ComposerBlock />
            <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-[38px] rounded-lg" />
              ))}
            </div>
          </>
        ) : (
          // A reader's composer is a read-only note.
          <Skeleton className="h-[46px] w-full rounded-xl" />
        )}
      </div>
    </Waiting>
  );
}

/**
 * `/chat/:conversationId` while its code loads: the stored conversation's wait, as the module
 * draws it (`ConversationSkeleton`) — turns at the top, the composer and its line at the bottom.
 */
export function ChatConversationSkeleton() {
  const { t } = useTranslation("common");
  const canWrite = usePermissions().can("chat:write");
  return (
    <ConversationSkeleton
      label={t("loading")}
      placeholder={canWrite ? <Skeleton className="h-3.5 w-48" /> : null}
    />
  );
}
