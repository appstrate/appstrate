// SPDX-License-Identifier: Apache-2.0

import { useEffect, type ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";
import { useBreadcrumbStore, type BreadcrumbEntry } from "@/stores/breadcrumb-store";

export type { BreadcrumbEntry };

interface PageHeaderProps {
  title: string;
  titleClassName?: string;
  /** Status or other compact metadata that semantically qualifies the title. */
  titleTrailing?: ReactNode;
  emoji?: string;
  /** Custom leading icon node; takes precedence over `emoji` when provided. */
  icon?: ReactNode;
  breadcrumbs?: BreadcrumbEntry[];
  actions?: ReactNode;
  /** Lets an action group move below the title when the container is genuinely too narrow. */
  wrapActions?: boolean;
  children?: ReactNode;
}

export function PageHeader({
  title,
  titleClassName,
  titleTrailing,
  emoji,
  icon,
  breadcrumbs,
  actions,
  wrapActions = false,
  children,
}: PageHeaderProps) {
  // Pages keep declaring their trail here, next to the code that knows the
  // dynamic labels; the shell header draws it. Keyed on the labels and hrefs
  // rather than the array itself, which every page rebuilds on each render and
  // which would otherwise publish in a loop.
  const setEntries = useBreadcrumbStore((s) => s.setEntries);
  const signature = JSON.stringify((breadcrumbs ?? []).map((c) => [c.label, c.href]));
  useEffect(() => {
    setEntries(breadcrumbs ?? []);
    return () => setEntries([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, setEntries]);

  return (
    <div data-page-header className="mb-4">
      <div
        className={
          wrapActions
            ? "flex min-h-9 flex-wrap items-center justify-between gap-3"
            : "flex min-h-9 items-center justify-between gap-4"
        }
      >
        <h2 className={cn("flex items-center gap-2 text-lg font-semibold", titleClassName)}>
          {icon ?? (emoji && <span>{emoji}</span>)}
          {title}
          {titleTrailing}
        </h2>
        {actions && (
          <div data-page-actions className="flex shrink-0 items-center gap-2">
            {actions}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
