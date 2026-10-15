// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Plus, SearchX, TriangleAlert, type LucideIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { errorDetail } from "../lib/mutation-error";
import { ApiError } from "../api/errors";
import type { MenuAction } from "../lib/menu-action";

/** The request failed, drawn like the empty state (a bare sentence would read as a rendering failure). Offers no Retry. */
export function ErrorState({
  message,
  error,
  compact,
}: {
  /** A line the caller already wrote. */
  message?: string;
  /** Shown as its translated refusal. */
  error?: unknown;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const detail = message ?? errorDetail(error);
  return (
    <EmptyState
      message={t("error.generic")}
      hint={detail}
      icon={TriangleAlert}
      tone="danger"
      compact={compact}
    />
  );
}

/**
 * A detail page's unreadable resource: missing and forbidden get the same panel, as the API
 * answers them alike. `hint` and `children` are the page's own way forward for that panel
 * (what to ask for, where to go); any other failure shows neither.
 */
export function ResourceErrorState({
  error,
  hint,
  children,
}: {
  error: unknown;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    return (
      <EmptyState
        icon={SearchX}
        message={t("error.resourceUnavailable")}
        hint={hint ?? t("error.resourceUnavailableHint")}
      >
        {children}
      </EmptyState>
    );
  }
  return <ErrorState error={error} />;
}

/**
 * Nothing here: an icon badge ringed by three concentric rings, the sentence, then the
 * way out. `compact` is for a frame that is already an answer (a list card, a tab body);
 * `tone` colours the glyph, the one cue telling a failure from an empty list at a glance.
 */
export function EmptyState({
  message,
  hint,
  compact,
  icon: Icon,
  tone = "neutral",
  children,
}: {
  message: string;
  hint?: React.ReactNode;
  compact?: boolean;
  icon: LucideIcon;
  tone?: "neutral" | "danger";
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col items-center px-8 text-center", compact ? "py-10" : "py-14")}>
      {/* The outermost ring overflows this box on purpose; shrink its height or the padding above and the frame clips it. */}
      <div
        className={cn(
          "relative grid place-items-center",
          compact ? "mb-3 h-28 w-40" : "mb-4 h-32 w-52",
        )}
      >
        <Ring className={compact ? "size-24" : "size-28"} />
        <Ring className={compact ? "size-34 opacity-60" : "size-40 opacity-60"} />
        <Ring className={compact ? "size-44 opacity-35" : "size-52 opacity-35"} />
        <div
          className={cn(
            "bg-card border-border relative grid place-items-center rounded-2xl border",
            compact ? "size-14" : "size-16",
          )}
        >
          <Icon
            className={cn(
              "size-6",
              tone === "danger" ? "text-destructive" : "text-muted-foreground",
            )}
          />
        </div>
      </div>
      <p className={cn("font-semibold tracking-tight", compact ? "text-[0.98rem]" : "text-base")}>
        {message}
      </p>
      {hint && (
        <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">{hint}</p>
      )}
      {children && <div className="mt-4 flex items-center gap-2 empty:hidden">{children}</div>}
    </div>
  );
}

/** A search or filter that matched nothing, with a way back to the whole list when filters can reset. */
export function NoMatchState({
  message,
  onReset,
  compact = true,
}: {
  message: string;
  onReset?: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation("common");
  return (
    <EmptyState message={message} icon={SearchX} compact={compact}>
      {onReset && (
        <Button variant="outline" size="sm" onClick={onReset}>
          {t("toolbar.clearAll")}
        </Button>
      )}
    </EmptyState>
  );
}

/**
 * The creation button of an empty collection: it does what the page's Actions menu entry
 * does (one `MenuAction`, handed to both). A `hidden` action renders nothing; a `to` or
 * `href` action has no button here.
 */
export function EmptyStateAction({
  action,
}: {
  action: Pick<MenuAction, "label" | "onSelect" | "hidden">;
}) {
  if (action.hidden) return null;
  return (
    <Button type="button" variant="outline" size="sm" onClick={action.onSelect}>
      <Plus />
      {action.label}
    </Button>
  );
}

/** One ring, centred on its parent. */
function Ring({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "border-border/60 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border",
        className,
      )}
    />
  );
}
