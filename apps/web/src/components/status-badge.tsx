// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { RunStatusIcon } from "@appstrate/ui/components/run-status";
import { ToneBadge, type ToneBadgeVariant } from "@/components/app-ui/status-variants";

/**
 * The outline counterpart to {@link Badge}: it qualifies WHAT a row is
 * ("Inline", "Distant", "Supprimé") where the status badge says how it ended.
 *
 * Shared by the run provenance badges (`RunProvenanceBadges`: run table, run
 * cards, dashboard, run-detail header) and the catalogue's "auto-installed"
 * badge, so the class string has one home.
 */
export function MetaBadge({
  label,
  title,
  italic,
}: {
  label: string;
  /** Why the badge is there, for the badge that explains a missing action. */
  title?: string;
  italic?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        "border-border text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase",
        italic && "italic",
        // A badge that explains itself on hover has to stay above a table
        // row's link overlay, or the row takes the hover with the click.
        title && "relative z-10",
      )}
    >
      {label}
    </span>
  );
}

const statusVariantMap: Record<string, ToneBadgeVariant> = {
  success: "success",
  failed: "failed",
  running: "running",
  pending: "pending",
  timeout: "timeout",
  cancelled: "cancelled",
};

export function Badge({
  status,
  compact,
  unread,
}: {
  status: string;
  compact?: boolean;
  unread?: boolean;
}) {
  const { t } = useTranslation();
  const variant = statusVariantMap[status] || "pending";
  const icon = <RunStatusIcon status={status} className="h-3 w-3" />;
  const dot = unread && (
    <span className="bg-destructive absolute -top-1 -right-1 size-2 rounded-full" />
  );

  if (!compact) {
    return (
      <span className="relative shrink-0">
        <ToneBadge variant={variant} className="gap-1">
          {icon}
          {t(`status.${status}`, status)}
        </ToneBadge>
        {dot}
      </span>
    );
  }

  return (
    <span className="relative shrink-0">
      {/* Mobile: bare icon, toned by its status */}
      <span className="sm:hidden [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      {/* Desktop: full badge */}
      <ToneBadge variant={variant} className="hidden gap-1 sm:inline-flex">
        {icon}
        {t(`status.${status}`, status)}
      </ToneBadge>
      {dot}
    </span>
  );
}
