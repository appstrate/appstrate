// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { ArrowRight, type LucideIcon } from "lucide-react";

/** The summary card shared by run, schedule and package details. */
export function DetailSectionCard({
  title,
  icon: Icon,
  headerAction,
  className,
  bodyClassName,
  headerInside = false,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  headerAction?: { label: string; onClick: () => void };
  className?: string;
  bodyClassName?: string;
  headerInside?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`flex min-w-0 flex-col ${headerInside ? "bg-muted/35 overflow-hidden rounded-lg border" : ""} ${className ?? ""}`}
    >
      {headerAction ? (
        <button
          type="button"
          aria-label={headerAction.label}
          title={headerAction.label}
          onClick={headerAction.onClick}
          className={`${headerInside ? "bg-muted/35 hover:bg-muted px-4 py-3" : "hover:bg-muted/40 mb-2 rounded-sm"} group focus-visible:ring-ring flex min-h-5 w-full items-center gap-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset`}
        >
          {Icon && <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
          <ArrowRight className="text-muted-foreground group-hover:text-primary group-focus-visible:text-primary size-4 shrink-0 transition-all group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
        </button>
      ) : (
        <div
          className={`${headerInside ? "bg-muted/35 px-4 py-3" : "mb-2"} flex min-h-5 items-center gap-2`}
        >
          {Icon && <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        </div>
      )}
      <div
        className={`bg-card h-full overflow-hidden ${headerInside ? "rounded-t-lg border-x-0 border-t border-b-0" : "rounded-lg border"} ${bodyClassName ?? "p-4"}`}
      >
        {children}
      </div>
    </section>
  );
}
