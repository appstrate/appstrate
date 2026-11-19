// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { COMPOSER_GRID_CLASS, DISCLAIMER_TEXT_CLASS } from "./phone-text.ts";

/**
 * A saved conversation while its history loads: the turns it will show, in
 * place, above an inert composer frame of the live one's height. The runtime is
 * not mounted, so the frame is static markup, not the real composer.
 */
export function ConversationSkeleton({
  label,
  placeholder,
  disclaimer,
}: {
  label: string;
  /** The composer's placeholder; null for a reader, who gets no composer. */
  placeholder: ReactNode;
  /** The writer's line under the composer: its text (`thread.disclaimer`), so it wraps as the live
   *  one does, or a bar where the text is not loaded yet. */
  disclaimer: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="flex size-full flex-col overflow-hidden px-4"
    >
      {/* The thread's column (`--thread-max-width`, 42rem). Turns follow `phone-text.ts`: a
          one-line bubble is 42px below `md` and 38px from it, a prose line 28px then 24px. The
          side padding sits outside the column, as on the thread's viewport. */}
      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-6 pt-8">
        <Skeleton aria-hidden className="ml-auto h-[42px] w-2/5 rounded-2xl md:h-[38px]" />
        <div aria-hidden className="flex flex-col gap-3 md:gap-2.5">
          <Skeleton className="h-4 w-full md:h-3.5" />
          <Skeleton className="h-4 w-11/12 md:h-3.5" />
          <Skeleton className="h-4 w-3/5 md:h-3.5" />
        </div>
        <Skeleton aria-hidden className="ml-auto h-[42px] w-1/3 rounded-2xl md:h-[38px]" />
        <div aria-hidden className="flex flex-col gap-3 md:gap-2.5">
          <Skeleton className="h-4 w-full md:h-3.5" />
          <Skeleton className="h-4 w-2/5 md:h-3.5" />
        </div>
      </div>
      {placeholder === null ? (
        // A reader's footer is the read-only note (`Composer`'s `chat:write` branch).
        <div aria-hidden className="mx-auto w-full max-w-2xl pb-4">
          <Skeleton className="h-[46px] w-full rounded-xl" />
        </div>
      ) : (
        <div aria-hidden className="mx-auto flex w-full max-w-2xl flex-col gap-2 pb-4">
          <ComposerSkeleton placeholder={placeholder} />
          {/* `Disclaimer`. Below `md` it steps aside while the composer has the focus, and the
              composer takes it on mount (`autoFocus`). */}
          <div className={cn(DISCLAIMER_TEXT_CLASS, "self-center max-md:hidden")}>{disclaimer}</div>
        </div>
      )}
    </div>
  );
}

/**
 * The writer's `Composer` (`thread.tsx`), inert: the `min-h-9` input line over the tool row —
 * `ComposerTools` on the left (attach, settings), the model picker's 30px trigger and send on the
 * right. Shared by every chat wait, the conversation's and the welcome screen's.
 */
export function ComposerSkeleton({
  placeholder,
  limited = false,
}: {
  placeholder: ReactNode;
  /** The limit chip is drawn: a new conversation started in a selected space is limited to it. */
  limited?: boolean;
}) {
  return (
    <div className="bg-card flex w-full flex-col gap-1 rounded-xl border px-3 py-2 shadow-sm">
      <div className={COMPOSER_GRID_CLASS}>
        <div className="text-muted-foreground flex min-h-9 items-center py-1 text-base [grid-area:input]">
          {placeholder}
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2 [grid-area:tools]">
          <div className="flex items-center gap-1.5">
            <Skeleton className="size-8 rounded-lg" />
            <Skeleton className="size-8 rounded-lg" />
            {limited && <Skeleton className="h-7 w-44 rounded-full" />}
          </div>
          <Skeleton className="h-[30px] w-32 rounded-md" />
        </div>
        <Skeleton className="size-8 rounded-lg [grid-area:send]" />
      </div>
    </div>
  );
}

/**
 * A row's place while the list loads, with the space line's: the same height and the same two
 * 16px lines as `ConversationRow`, so the list does not shift on load.
 */
export function ConversationRowSkeleton() {
  return (
    <div
      data-sidebar="menu-skeleton"
      className="flex h-12 flex-col justify-center gap-0.5 rounded-md px-2"
    >
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="h-4 w-2/5" />
    </div>
  );
}
