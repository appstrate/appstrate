// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";
import type { BreadcrumbEntry } from "@/stores/breadcrumb-store";
import { usePageBreadcrumb } from "@/hooks/use-overlay-breadcrumb";

interface PageHeaderProps {
  title: ReactNode;
  /** Level-one collection pages use a larger destination title. */
  variant?: "default" | "collection";
  titleClassName?: string;
  /** Custom leading icon node. */
  icon?: ReactNode;
  breadcrumbs?: BreadcrumbEntry[];
  actions?: ReactNode;
  /** Lets an action group move below the title when the container is genuinely too narrow. */
  wrapActions?: boolean;
  children?: ReactNode;
}

/** The page's title: its one `<h1>`, every section below it an `<h2>`. */
export function PageHeader({
  title,
  variant = "default",
  titleClassName,
  icon,
  breadcrumbs,
  actions,
  wrapActions = false,
  children,
}: PageHeaderProps) {
  // Pages declare their trail here, next to the code that knows the dynamic
  // labels; the shell header draws it.
  usePageBreadcrumb(breadcrumbs ?? []);

  return (
    <div data-page-header className="mb-4">
      <div
        className={
          wrapActions
            ? "flex min-h-9 flex-wrap items-center justify-between gap-3"
            : "flex min-h-9 items-center justify-between gap-4"
        }
      >
        <h1
          className={cn(
            "flex items-center gap-2 font-semibold",
            variant === "collection" ? "text-lg md:text-2xl" : "text-lg",
            titleClassName,
          )}
        >
          {icon}
          {title}
        </h1>
        {actions && (
          <div
            data-page-actions
            className={cn(
              "flex items-center gap-2",
              wrapActions ? "max-w-full flex-wrap" : "shrink-0",
            )}
          >
            {actions}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
