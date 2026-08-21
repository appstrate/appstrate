// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Spinner } from "./spinner";
import type { LucideIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";

export function LoadingState() {
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

export function ErrorState({ message }: { message?: string }) {
  const { t } = useTranslation();
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
      <p>{t("error.generic")}</p>
      {message && <p className="mt-1 text-sm">{message}</p>}
    </div>
  );
}

/**
 * Nothing here — said the way the reference says it (`empty-state`): the icon
 * in a raised badge at the centre of three concentric rings, then the sentence,
 * then whatever gets you out of the emptiness.
 *
 * The rings are the whole point of the treatment. A 40px glyph at 40% opacity
 * over an empty card reads as a rendering failure; the same glyph on a card
 * with a border and a shadow, ringed, reads as a state someone designed. Same
 * props as before, so every screen that already had an empty state gets it.
 *
 * `compact` is for an empty state inside a frame that is already an answer
 * (a list card, a tab body); the full one is for a page that has nothing else
 * on it.
 */
export function EmptyState({
  message,
  hint,
  compact,
  icon: Icon,
  children,
}: {
  message: string;
  hint?: React.ReactNode;
  compact?: boolean;
  icon: LucideIcon;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col items-center px-8 text-center", compact ? "py-10" : "py-14")}>
      {/* The rings overflow this box on purpose — they are wider than they are
          tall, like the reference's — so the box has to stay narrower than the
          padding around it or the outermost one meets the card's edge. */}
      <div
        className={cn(
          "relative grid place-items-center",
          compact ? "mb-3 h-28 w-40" : "mb-4 h-32 w-52",
        )}
      >
        {/* Decorative: the rings carry no information the text does not. */}
        <Ring size={compact ? "size-24" : "size-28"} opacity="opacity-100" />
        <Ring size={compact ? "size-34" : "size-40"} opacity="opacity-60" />
        <Ring size={compact ? "size-44" : "size-52"} opacity="opacity-35" />
        <div
          className={cn(
            "bg-card border-border relative grid place-items-center rounded-2xl border shadow-md",
            compact ? "size-14" : "size-16",
          )}
        >
          <Icon className="text-muted-foreground size-6" />
        </div>
      </div>
      <p className={cn("font-semibold tracking-tight", compact ? "text-[0.98rem]" : "text-base")}>
        {message}
      </p>
      {hint && (
        <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">{hint}</p>
      )}
      {children && <div className="mt-4 flex items-center gap-2">{children}</div>}
    </div>
  );
}

/** One ring, centred on its parent and clipped by it. */
function Ring({ size, opacity }: { size: string; opacity: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "border-border/60 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border",
        size,
        opacity,
      )}
    />
  );
}
