// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { PlusIcon } from "lucide-react";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { COMPOSER_BUTTON_CLASS } from "./touch-targets.ts";
import {
  COMPOSER_FIELD_CLASS,
  COMPOSER_ROW_CLASS,
  COMPOSER_SEND_CLASS,
  COMPOSER_TOOLS_CLASS,
  DISCLAIMER_CLASS,
} from "./phone-text.ts";

export { NEW_CONVERSATION_CLASS } from "./phone-text.ts";

/** The box of the composer's `size="icon-sm"` buttons: 44 px on touch, 32 px under a mouse. */
const COMPOSER_BUTTON_BOX_CLASS = cn("desktop-pointer:size-8 size-11", COMPOSER_BUTTON_CLASS);

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
  /** The writer's line under the composer from `md` up (a phone has it in the "+" panel): its text
   *  (`thread.disclaimer`), so it wraps as the live one does, or a bar where it is not loaded yet. */
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
          <div className={cn(DISCLAIMER_CLASS, "self-center")}>{disclaimer}</div>
        </div>
      )}
    </div>
  );
}

/**
 * The writer's `Composer` (`thread.tsx`), inert: from `md` up the `min-h-9` input line over the
 * tool row — `ComposerTools` on the left (attach, the panel's settings button), send on the right;
 * on a phone one line, the "+", the field, send. Shared by every chat wait, the conversation's and
 * the welcome screen's.
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
      <div className={COMPOSER_ROW_CLASS}>
        <div className={COMPOSER_TOOLS_CLASS}>
          <div className="flex items-center gap-1.5">
            <Skeleton className={COMPOSER_BUTTON_BOX_CLASS} />
            <Skeleton className={cn(COMPOSER_BUTTON_BOX_CLASS, "max-md:hidden")} />
            {limited && (
              <Skeleton className="desktop-pointer:h-7 h-10 w-44 rounded-full max-md:hidden" />
            )}
          </div>
        </div>
        <div
          className={cn(
            "text-muted-foreground desktop-pointer:min-h-9 flex min-w-0 items-center overflow-hidden py-1 text-base",
            COMPOSER_FIELD_CLASS,
          )}
        >
          {placeholder}
        </div>
        <div className={COMPOSER_SEND_CLASS}>
          <Skeleton className={COMPOSER_BUTTON_BOX_CLASS} />
        </div>
      </div>
    </div>
  );
}

/**
 * A row's place while the list loads: the same height as `ConversationRow` (32 px under a mouse,
 * 36 on touch), so the list does not shift on load.
 */
export function ConversationRowSkeleton() {
  return (
    <div
      data-sidebar="menu-skeleton"
      className="desktop-pointer:h-8 flex h-9 items-center rounded-md px-2"
    >
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

/**
 * "New conversation"'s content, the same on every format: its "+" in a round tile, as the rows below
 * it carry their marks, then its words. Shared by the live row (`ChatConversationList`) and the
 * shell's skeleton of it, so the two cannot drift; both sit in a `SidebarMenuButton` styled with
 * `NEW_CONVERSATION_CLASS`. In the icon rail the tile steps aside and the "+" is the button's icon.
 */
export function NewConversationContent({ label }: { label: string }) {
  return (
    <>
      <span className="bg-sidebar-accent desktop-pointer:size-6 flex size-7 shrink-0 items-center justify-center rounded-full group-data-[collapsible=icon]:contents [&>svg]:size-4">
        <PlusIcon />
      </span>
      <span>{label}</span>
    </>
  );
}
