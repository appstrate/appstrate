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
 * waits share one shape. `title` is drawn as text when known; `parent` is the
 * part of the header's small line the address already tells.
 */
export function DetailPageSkeleton({
  title,
  parent,
  tabCount,
}: {
  title?: string;
  parent?: BreadcrumbEntry;
  tabCount: number;
}) {
  return (
    <Waiting>
      <DetailBarSkeleton title={title} parent={parent} tabCount={tabCount} />
      <div className="bg-card rounded-lg border p-6">
        <CardBlocks count={3} />
      </div>
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
      parent={listCrumb}
      // An agent offers four tabs, every other family three.
      tabCount={type === "agent" ? 4 : 3}
    />
  );
}

/** A run's page, under its agent. */
export function RunDetailSkeleton({ agentName }: { agentName?: string }) {
  const { scope, name } = useParams();
  return (
    <DetailPageSkeleton
      parent={agentName ? { label: agentName, href: `/agents/${scope}/${name}#runs` } : undefined}
      tabCount={3}
    />
  );
}

/** A schedule's page, under the schedules list. */
export function ScheduleDetailSkeleton() {
  const { t } = useTranslation("agents");
  return (
    <DetailPageSkeleton
      parent={{ label: t("common:nav.schedules"), href: "/schedules" }}
      tabCount={3}
    />
  );
}

/** A collection page: title, toolbar, the table's frame with its header and rows. */
export function ListPageSkeleton() {
  return (
    <Waiting>
      <HeaderBlocks breadcrumbs={NO_CRUMBS} />
      <div className="mb-3 flex items-center justify-between gap-2">
        <Skeleton className="h-9 w-72 max-w-full" />
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="bg-card overflow-hidden rounded-lg border">
        <div className="border-border flex h-10 items-center border-b px-4">
          <Skeleton className="h-3 w-1/3" />
        </div>
        {Array.from({ length: 3 }, (_, i) => (
          <div
            key={i}
            className="border-border/60 flex h-12 items-center border-b px-4 last:border-b-0"
          >
            <Skeleton className="h-3.5 w-full" />
          </div>
        ))}
      </div>
    </Waiting>
  );
}

/** A settings page or section: `SettingRow`s, label over description over control. */
export function SettingsSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <Waiting className={className}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="pb-8 last:pb-0">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="mt-2 h-3 w-72 max-w-full" />
          <Skeleton className="mt-3 h-9 w-full max-w-md" />
        </div>
      ))}
    </Waiting>
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
          <Skeleton key={i} className="h-[7.5rem] rounded-xl" />
        ))}
      </div>
      <div>
        <Skeleton className="mb-3 h-5 w-36" />
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-[19rem] shrink-0 rounded-xl" />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.8fr)]">
        {[3, 2].map((rows, i) => (
          <div key={i}>
            <Skeleton className="mb-3 h-5 w-40" />
            <div className="bg-card divide-border divide-y rounded-xl border">
              {Array.from({ length: rows }, (_, j) => (
                <div key={j} className="flex min-h-[74px] items-center gap-3 px-4">
                  <Skeleton className="size-8 shrink-0 rounded-md" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-3.5 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Waiting>
  );
}

/** The whole dashboard, greeting included: the route's fallback. */
export function DashboardSkeleton() {
  const { t } = useTranslation("agents");
  usePageBreadcrumb([{ label: t("common:nav.dashboard") }]);
  return (
    <div className="mx-auto w-full max-w-[1300px]">
      <div className="mb-4 flex min-h-9 items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-3.5 w-56" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>
      <DashboardBodySkeleton />
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
      <div className="min-w-0 flex-1 p-6 pt-12">
        <Skeleton className="mb-6 h-7 w-48" />
        {list ? <TextSkeleton lines={6} /> : <SettingsSkeleton />}
      </div>
    </>
  );
}

/** The chat panel while its code loads: the welcome lines over the composer. */
export function ChatPanelSkeleton() {
  return (
    <Waiting className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-3 px-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-3.5 w-72 max-w-full" />
      <Skeleton className="mt-3 h-28 w-full rounded-2xl" />
    </Waiting>
  );
}
