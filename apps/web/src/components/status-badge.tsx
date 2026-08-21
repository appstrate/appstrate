// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { CheckCircle2, XCircle, Clock, Ban } from "lucide-react";
import { Spinner } from "./spinner";
import { cn } from "@appstrate/ui/cn";
import { Badge as UIBadge } from "@appstrate/ui/components/badge";
import type { BadgeProps } from "@appstrate/ui/components/badge";

/**
 * The outline counterpart to {@link Badge}: it qualifies WHAT a row is
 * ("Inline", "Distant", "Supprimé") where the status badge says how it ended.
 *
 * Here rather than in one of its callers because both run surfaces render the
 * same three of them — the table and the strip under the run-detail header —
 * and they were splitting the same twenty-word class string between two files
 * the moment the list stopped being a row.
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

const statusVariantMap: Record<string, BadgeProps["variant"]> = {
  success: "success",
  failed: "failed",
  running: "running",
  pending: "pending",
  timeout: "timeout",
  cancelled: "cancelled",
};

const statusColorMap: Record<string, string> = {
  success: "text-success",
  failed: "text-destructive",
  running: "text-primary",
  pending: "text-muted-foreground",
  timeout: "text-warning",
  cancelled: "text-muted-foreground",
};

const statusIconMap: Record<string, React.ReactNode> = {
  running: <Spinner className="h-3 w-3" />,
  pending: <Spinner className="h-3 w-3" />,
  success: <CheckCircle2 className="h-3 w-3" />,
  failed: <XCircle className="h-3 w-3" />,
  timeout: <Clock className="h-3 w-3" />,
  cancelled: <Ban className="h-3 w-3" />,
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
  const icon = statusIconMap[status];
  const dot = unread && (
    <span className="bg-destructive absolute -top-1 -right-1 size-2 rounded-full" />
  );

  if (!compact) {
    return (
      <span className="relative shrink-0">
        <UIBadge variant={variant} className="gap-1">
          {icon}
          {t(`status.${status}`, status)}
        </UIBadge>
        {dot}
      </span>
    );
  }

  return (
    <span className="relative shrink-0">
      {/* Mobile: bare icon with status color */}
      <span
        className={`sm:hidden [&_svg]:h-4 [&_svg]:w-4 ${statusColorMap[status] ?? "text-muted-foreground"}`}
      >
        {icon}
      </span>
      {/* Desktop: full badge */}
      <UIBadge variant={variant} className="hidden gap-1 sm:inline-flex">
        {icon}
        {t(`status.${status}`, status)}
      </UIBadge>
      {dot}
    </span>
  );
}
