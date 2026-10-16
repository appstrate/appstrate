// SPDX-License-Identifier: Apache-2.0

import { useId, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { TargetArrow, TargetLink, type ActionTarget } from "./action-target";

const HEADER_CLASS = "bg-muted/35 flex min-h-5 w-full items-center gap-2 px-4 py-3";
const TARGET_CLASS =
  "hover:bg-muted group focus-visible:ring-ring text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset";

/**
 * The summary card shared by run, schedule, agent and package details: a muted
 * header (icon, title, optional arrow to where the section continues) over a
 * white body. The section is named by its title for assistive technology.
 */
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
  /** Makes the whole header lead somewhere; `label` names that destination. */
  headerAction?: { label: string } & ActionTarget;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const heading = (
    <>
      {Icon && <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />}
      <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold">
        {title}
      </h2>
      {headerAction && <TargetArrow className="text-muted-foreground size-4" />}
    </>
  );

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "bg-muted/35 flex min-w-0 flex-col overflow-hidden rounded-lg border",
        className,
      )}
    >
      {headerAction ? (
        <TargetLink
          target={headerAction}
          label={headerAction.label}
          className={cn(HEADER_CLASS, TARGET_CLASS)}
        >
          {heading}
        </TargetLink>
      ) : (
        <div className={HEADER_CLASS}>{heading}</div>
      )}
      <div
        className={cn(
          "bg-card h-full overflow-hidden rounded-t-lg border-x-0 border-t border-b-0",
          bodyClassName ?? "p-4",
        )}
      >
        {children}
      </div>
    </section>
  );
}
