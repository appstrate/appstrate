// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * Onboarding-style empty state (Apify pattern): a tinted icon tile floating on
 * a radially-faded dot grid, a benefit-oriented title, a short description and
 * a primary + secondary call to action.
 */
export function RichEmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
}) {
  return (
    <div className="border-border bg-card relative flex flex-col items-center justify-center overflow-hidden rounded-[var(--radius)] border px-6 py-16 text-center shadow-sm">
      {/* Faded dot grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70 [background-image:radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_60%_55%_at_50%_42%,#000,transparent)]"
      />
      <div className="relative">
        <div className="border-border bg-muted text-muted-foreground mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl border shadow-sm">
          <Icon className="size-7" />
        </div>
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        {description && (
          <p className="text-muted-foreground mx-auto mt-1.5 max-w-sm text-sm leading-relaxed">
            {description}
          </p>
        )}
        {(action || secondaryAction) && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {action}
            {secondaryAction}
          </div>
        )}
      </div>
    </div>
  );
}
