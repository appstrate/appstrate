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
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { usePageBreadcrumb } from "../hooks/use-overlay-breadcrumb";
import type { BreadcrumbEntry } from "../stores/breadcrumb-store";

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
    <div className="space-y-2.5">
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
 * `PageHeader`'s box: the same height, so the real title replaces it in place.
 * Publishes the part of the trail the page already knows from its address.
 */
function HeaderBlocks({
  breadcrumbs,
  icon,
  subtitle,
  collection,
}: {
  breadcrumbs: BreadcrumbEntry[];
  icon?: boolean;
  subtitle?: boolean;
  collection?: boolean;
}) {
  usePageBreadcrumb(breadcrumbs);
  return (
    <div data-page-header className="mb-4">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          {icon && <Skeleton className="size-10 shrink-0 rounded-[10px]" />}
          <Skeleton className={collection ? "h-7 w-44" : "h-6 w-52"} />
        </div>
        <Skeleton className="h-8 w-24" />
      </div>
      {subtitle && (
        <div className="mt-2 space-y-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3.5 w-80 max-w-full" />
        </div>
      )}
    </div>
  );
}

function CardBlocks({ count }: { count: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-4 rounded-lg border p-4">
          <Skeleton className="h-4 w-24" />
          <Lines lines={3} />
        </div>
      ))}
    </div>
  );
}

/**
 * A resource's page: identity header, tab strip, the tab's framed panel.
 * `subtitle` for a header that carries lines under its title (a package's id
 * and description).
 */
export function DetailPageSkeleton({
  breadcrumbs = NO_CRUMBS,
  subtitle,
}: {
  breadcrumbs?: BreadcrumbEntry[];
  subtitle?: boolean;
}) {
  return (
    <Waiting>
      <HeaderBlocks breadcrumbs={breadcrumbs} icon subtitle={subtitle} />
      <Skeleton className="mt-6 mb-3 h-9 w-72 max-w-full rounded-lg" />
      <div className="bg-card rounded-lg border p-6 shadow-sm">
        <CardBlocks count={3} />
      </div>
    </Waiting>
  );
}

/** A collection page: title, toolbar, the table's frame with its rows. */
export function ListPageSkeleton() {
  return (
    <Waiting>
      <HeaderBlocks breadcrumbs={NO_CRUMBS} collection />
      <div className="mb-3 flex items-center justify-between gap-2">
        <Skeleton className="h-9 w-72 max-w-full" />
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="bg-card overflow-hidden rounded-lg border shadow-sm">
        {Array.from({ length: 6 }, (_, i) => (
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

/** A form page with its own header (the package editor). */
export function FormPageSkeleton() {
  return (
    <Waiting>
      <HeaderBlocks breadcrumbs={NO_CRUMBS} />
      <SettingsSkeleton rows={4} />
    </Waiting>
  );
}

/** The dashboard: greeting, the four figures, recent agents, upcoming schedules. */
export function DashboardSkeleton() {
  const { t } = useTranslation("agents");
  usePageBreadcrumb([{ label: t("dashboard.breadcrumb") }]);
  return (
    <Waiting className="mx-auto w-full max-w-[1300px]">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-3.5 w-48" />
      </div>
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
      </div>
      <Skeleton className="mb-3 h-5 w-36" />
      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      <Skeleton className="mb-3 h-5 w-44" />
      <Skeleton className="h-16 rounded-lg" />
    </Waiting>
  );
}
