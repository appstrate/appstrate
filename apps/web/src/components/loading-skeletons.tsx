// SPDX-License-Identifier: Apache-2.0

/**
 * Data on its way, drawn as grey blocks laid out as the content will be (a spinner is a
 * control at work, never content on its way). A route's fallback (`skeletonOf` in
 * `app.tsx`) is the same skeleton its page draws, so chunk and data wait under one shape.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import type { PackageType } from "@appstrate/core/validation";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Dialog, DialogContent, DialogTitle } from "@appstrate/ui/components/dialog";
import { cn } from "@appstrate/ui/cn";
import { usePageBreadcrumb } from "../hooks/use-overlay-breadcrumb";
import type { BreadcrumbEntry } from "../stores/breadcrumb-store";
import { usePackageListCrumb } from "../hooks/use-package-list-crumb";
import { PageHeader } from "./page-header";

/** One `status` for assistive technology; the blocks themselves are hidden from it. */
function Waiting({ className, children }: { className?: string; children: ReactNode }) {
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

/** `PageHeader` with blocks for its content: the same box, so the real title replaces it in place. */
function HeaderBlocks({
  breadcrumbs,
  icon,
  subtitle,
  actions = true,
  collection,
}: {
  breadcrumbs: BreadcrumbEntry[];
  icon?: boolean;
  subtitle?: "lines" | "line";
  actions?: boolean;
  collection?: boolean;
}) {
  return (
    <PageHeader
      title={<Skeleton className={collection ? "h-7 w-44" : "h-6 w-52"} />}
      icon={icon && <Skeleton className="size-10 shrink-0 rounded-[10px]" />}
      breadcrumbs={breadcrumbs}
      actions={actions && <Skeleton className="h-8 w-24 shrink-0" />}
    >
      {subtitle === "lines" && (
        <div className="mt-2 flex flex-col gap-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3.5 w-80 max-w-full" />
        </div>
      )}
      {subtitle === "line" && <Skeleton className="mt-2 mb-2 h-3.5 w-72 max-w-full" />}
    </PageHeader>
  );
}

const TAB_STRIP = "mt-6 mb-3 h-9 w-72 max-w-full rounded-lg";

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
 * A resource's page: identity header, tab strip, the tab's framed panel. Each
 * detail route draws the same element as its fallback and as its page's
 * loading state, so the two waits share one shape. `subtitle` is what the
 * header carries under its title (a package's id and description: `lines`; a
 * run's summary: `line`).
 */
export function DetailPageSkeleton({
  breadcrumbs = NO_CRUMBS,
  icon = true,
  subtitle,
}: {
  breadcrumbs?: BreadcrumbEntry[];
  icon?: boolean;
  subtitle?: "lines" | "line";
}) {
  return (
    <Waiting>
      <HeaderBlocks breadcrumbs={breadcrumbs} icon={icon} subtitle={subtitle} />
      <Skeleton className={TAB_STRIP} />
      <div className="bg-card rounded-lg border p-6">
        <CardBlocks count={3} />
      </div>
    </Waiting>
  );
}

/** A package's page while its detail loads (and its route's fallback): its family's crumb. */
export function PackageDetailSkeleton({ type }: { type: PackageType }) {
  const listCrumb = usePackageListCrumb(type);
  return <DetailPageSkeleton breadcrumbs={[listCrumb]} subtitle="lines" />;
}

/** A run's page: no identity tile, one summary line, under its agent's crumbs. */
export function RunDetailSkeleton({ agentName }: { agentName?: string }) {
  const { t } = useTranslation("agents");
  const { scope, name } = useParams();
  const crumbs: BreadcrumbEntry[] = [{ label: t("detail.breadcrumb"), href: "/agents" }];
  if (agentName) crumbs.push({ label: agentName, href: `/agents/${scope}/${name}` });
  return <DetailPageSkeleton breadcrumbs={crumbs} icon={false} subtitle="line" />;
}

/** A schedule's page, under the schedules crumb. */
export function ScheduleDetailSkeleton() {
  const { t } = useTranslation("agents");
  return (
    <DetailPageSkeleton breadcrumbs={[{ label: t("common:nav.schedules"), href: "/schedules" }]} />
  );
}

/** A collection page: title, toolbar, the table's frame with its header and rows. */
export function ListPageSkeleton() {
  return (
    <Waiting>
      <HeaderBlocks breadcrumbs={NO_CRUMBS} collection />
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

/** A form page with its own header and tabs (the package editor). */
export function FormPageSkeleton() {
  return (
    <Waiting>
      <HeaderBlocks breadcrumbs={NO_CRUMBS} actions={false} />
      <Skeleton className={TAB_STRIP} />
      <SettingsSkeleton rows={4} className="mt-4" />
    </Waiting>
  );
}

/** The dashboard below its greeting: the figures, recent agents, the two lists. */
export function DashboardBodySkeleton() {
  return (
    <Waiting className="space-y-8">
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
    <div className="space-y-8">
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
 * A routed overlay (settings, catalogue) whose code is not loaded yet: the
 * `PanelDialog` frame, its rail and its page as blocks. Reached only on a
 * cold address, since the shell preloads the overlays on intent.
 */
export function OverlayPanelSkeleton({ list }: { list?: boolean }) {
  return (
    <Dialog open>
      <DialogContent
        className="flex h-[min(720px,calc(100dvh-6rem))] w-[min(1080px,calc(100vw-4rem))] max-w-none gap-0 overflow-hidden p-0 max-sm:-m-4 max-sm:h-[100dvh] max-sm:w-[100vw] max-sm:rounded-none max-sm:border-0"
        closeClassName="hidden"
      >
        <DialogTitle className="sr-only">…</DialogTitle>
        <aside className="bg-sidebar border-sidebar-border flex w-56 shrink-0 flex-col gap-2 border-r p-3 max-md:hidden">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </aside>
        <div className="min-w-0 flex-1 p-6 pt-12">
          <Skeleton className="mb-6 h-7 w-48" />
          {list ? <TextSkeleton lines={6} /> : <SettingsSkeleton />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The chat panel while its code loads: the welcome lines over the composer. */
export function ChatPanelSkeleton() {
  return (
    <Waiting className="mx-auto flex size-full max-w-3xl flex-col items-center justify-center gap-3 px-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-3.5 w-72 max-w-full" />
      <Skeleton className="mt-3 h-28 w-full rounded-2xl" />
    </Waiting>
  );
}
