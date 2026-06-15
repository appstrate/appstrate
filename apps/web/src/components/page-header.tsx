// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export interface BreadcrumbEntry {
  label: string;
  href?: string;
  node?: ReactNode;
}

interface PageHeaderProps {
  title: string;
  emoji?: string;
  breadcrumbs?: BreadcrumbEntry[];
  actions?: ReactNode;
  children?: ReactNode;
  /**
   * Sticks the header to the top of the scroll area (detail-page chrome).
   * Full-bleeds out of the page's `p-6` padding so the bottom border spans
   * the full width, mirroring Apify's pinned entity header.
   */
  sticky?: boolean;
}

export function PageHeader({
  title,
  emoji,
  breadcrumbs,
  actions,
  children,
  sticky,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "mb-4",
        sticky &&
          "bg-background sticky top-0 z-20 -mx-6 border-b px-6 pt-4 pb-3",
      )}
    >
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumb className="mb-2">
          <BreadcrumbList>
            {breadcrumbs.map((crumb, i) => (
              <BreadcrumbItem key={i}>
                {i > 0 && <BreadcrumbSeparator />}
                {crumb.node ? (
                  crumb.node
                ) : crumb.href ? (
                  <BreadcrumbLink asChild>
                    <Link to={crumb.href}>{crumb.label}</Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      )}
      <div className="flex min-h-9 items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">
          {emoji && <span className="mr-2">{emoji}</span>}
          {title}
        </h2>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
