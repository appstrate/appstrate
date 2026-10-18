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

import { Card } from "@appstrate/ui/components/card";
import { CardList } from "./card-list";
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
}: {
  title?: string;
  trail?: readonly BreadcrumbEntry[];
  tabCount: number;
}) {
  return (
    <Waiting>
      <DetailBarSkeleton title={title} trail={trail} tabCount={tabCount} />
      <Card className="p-6">
        <CardBlocks count={3} />
      </Card>
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
  return <CollectionBlocks cards={view === "cards"} />;
}

/** A collection under its title: `ListToolbar`, then `DataTable`'s frame, head and rows. */
function CollectionBlocks({ cards = false }: { cards?: boolean }) {
  return (
    <>
      {/* `ListToolbar`: an `h-8` search of at most 280px, then its filter button. */}
      <div className="mb-3 flex items-center gap-2">
        <Skeleton className="h-8 min-w-40 flex-1 sm:max-w-[280px]" />
        <Skeleton className="h-8 w-20" />
      </div>
      {cards ? (
        <CardGridSkeleton />
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

/** A form page with its header and tabs in the shell header (the package editor). */
export function FormPageSkeleton() {
  return (
    <Waiting>
      <DetailBarSkeleton tabCount={3} />
      <SettingsSkeleton rows={4} />
    </Waiting>
  );
}

/** The dashboard below its greeting: the figures, recent agents, the two lists. */
export function DashboardBodySkeleton() {
  return (
    <Waiting>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
      <div>
        <Skeleton className="mb-3 h-6 w-36" />
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-[19rem] shrink-0 rounded-xl" />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.8fr)]">
        {/* Recent runs (`RunRow`, `min-h-16`), then upcoming schedules (`min-h-[74px]`). */}
        {(
          [
            [3, "min-h-16"],
            [2, "min-h-[74px]"],
          ] as const
        ).map(([rows, rowHeight], i) => (
          <div key={i}>
            <Skeleton className="mb-3 h-6 w-40" />
            <CardList>
              {Array.from({ length: rows }, (_, j) => (
                <div key={j} className={cn("flex items-center gap-3 px-4", rowHeight)}>
                  <Skeleton className="size-8 shrink-0 rounded-md" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-3.5 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </CardList>
          </div>
        ))}
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
  const canWrite = usePermissions().can("chat:write");
  return (
    <Waiting className="flex size-full flex-col overflow-hidden">
      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-6 px-4 pt-8">
        <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
        <Lines lines={3} />
        <Skeleton className="ml-auto h-10 w-1/3 rounded-2xl" />
        <Lines lines={2} />
      </div>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pb-4">
        {canWrite ? (
          <>
            <ComposerBlock />
            <div className="flex h-4 justify-center">
              <Skeleton className="h-3 w-64" />
            </div>
          </>
        ) : (
          <Skeleton className="h-[46px] w-full rounded-xl" />
        )}
      </div>
    </Waiting>
  );
}
