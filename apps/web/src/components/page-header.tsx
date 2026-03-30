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
  breadcrumbs?: BreadcrumbEntry[];
  actions?: ReactNode;
  children?: ReactNode;
}

export function PageHeader({ title, emoji, breadcrumbs, actions, children }: PageHeaderProps) {
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
        <h2 className="text-lg font-semibold">
          {emoji && <span className="mr-2">{emoji}</span>}
          {title}
        </h2>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
