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
  children,
}: {
  title: string;
  icon?: LucideIcon;
  headerAction?: { label: string; onClick: () => void };
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`bg-muted/35 flex min-w-0 flex-col overflow-hidden rounded-lg border ${className ?? ""}`}
    >
      {headerAction ? (
        <button
          type="button"
          aria-label={headerAction.label}
          title={headerAction.label}
          onClick={headerAction.onClick}
          className="bg-muted/35 hover:bg-muted group focus-visible:ring-ring flex min-h-5 w-full items-center gap-2 px-4 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
        >
          {Icon && <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
          <ArrowRight className="text-muted-foreground group-hover:text-primary group-focus-visible:text-primary size-4 shrink-0 transition-all group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
        </button>
      ) : (
        <div className="bg-muted/35 flex min-h-5 items-center gap-2 px-4 py-3">
          {Icon && <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        </div>
      )}
      <div
        className={`bg-card h-full overflow-hidden rounded-t-lg border-x-0 border-t border-b-0 ${bodyClassName ?? "p-4"}`}
      >
        {children}
      </div>
    </section>
  );
}
