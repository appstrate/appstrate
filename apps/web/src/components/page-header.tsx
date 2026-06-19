// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
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
  /** Custom leading icon node; takes precedence over `emoji` when provided. */
  icon?: ReactNode;
  breadcrumbs?: BreadcrumbEntry[];
  actions?: ReactNode;
  children?: ReactNode;
}

export function PageHeader({
  title,
  emoji,
  icon,
  breadcrumbs,
  actions,
  children,
}: PageHeaderProps) {
  return (
    <div className="mb-4">
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
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          {icon ?? (emoji && <span>{emoji}</span>)}
          {title}
        </h2>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
