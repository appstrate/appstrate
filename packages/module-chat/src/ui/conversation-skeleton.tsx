// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { PlusIcon, SearchIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@appstrate/ui/components/sidebar";
import { COMPOSER_BUTTON_CLASS } from "./touch-targets.ts";
import {
  COMPOSER_FIELD_CLASS,
  COMPOSER_ROW_CLASS,
  COMPOSER_SEND_CLASS,
  COMPOSER_TOOLS_CLASS,
  DISCLAIMER_CLASS,
  NEW_CONVERSATION_CLASS,
  NEW_CONVERSATION_ICON_CLASS,
  SEARCH_TOGGLE_CLASS,
  THREAD_SIDE_PADDING_CLASS,
} from "./phone-text.ts";

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
      className={cn("flex size-full flex-col overflow-hidden", THREAD_SIDE_PADDING_CLASS)}
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
 * The conversation list's rows while they load, inside its `SidebarMenu`: under a date group's
 * label (`dated`, the list's shape outside a search) or bare (search results), five rows of
 * `ConversationRow`'s box — its height, and its right padding, which keeps room for a writer's
 * « … » on touch and so sets where the space tiles end.
 */
export function ConversationGroupSkeleton({
  canWrite,
  dated,
}: {
  canWrite: boolean;
  dated: boolean;
}) {
  const rows = Array.from({ length: 5 }, (_, i) => (
    <SidebarMenuItem key={i}>
      <div
        data-sidebar="menu-skeleton"
        className={cn(
          "desktop-pointer:h-8 flex h-12 items-center gap-2 rounded-md px-2",
          canWrite && "desktop-pointer:pr-2 pr-11",
        )}
      >
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="ml-auto size-4 shrink-0 rounded-sm" />
      </div>
    </SidebarMenuItem>
  ));
  if (!dated) return rows;
  return (
    <li aria-hidden className="flex flex-col gap-1">
      <SidebarGroupLabel className="desktop-pointer:h-6 mt-1 h-10 justify-start gap-1 px-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="size-3 rounded-sm" />
      </SidebarGroupLabel>
      <ul className="flex flex-col gap-1">{rows}</ul>
    </li>
  );
}

/**
 * `ChatConversationList` while the host has not mounted it yet (its permissions and chunk load):
 * a writer's list as it loads, the one that has « Nouvelle conversation » — that row real (the
 * surface's primary action), disabled; the search, which the list shows while it loads; then the
 * rows under a date group's label.
 */
export function ConversationListSkeleton({ newConversation }: { newConversation: string }) {
  return (
    <>
      <SidebarGroup className="pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              disabled
              tooltip={newConversation}
              className={cn(NEW_CONVERSATION_CLASS, "max-md:pr-12")}
            >
              <span className={NEW_CONVERSATION_ICON_CLASS}>
                <PlusIcon />
              </span>
              <span>{newConversation}</span>
            </SidebarMenuButton>
            <span aria-hidden className={cn(SEARCH_TOGGLE_CLASS, "absolute top-0 right-0")}>
              <SearchIcon className="size-5" />
            </span>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <div
        aria-hidden
        className="px-2 pt-2 pb-1 group-data-[collapsible=icon]:hidden max-md:hidden"
      >
        <Skeleton className="h-8 w-full rounded-md" />
      </div>
      <SidebarGroup className="min-h-0 flex-1 pt-0 group-data-[collapsible=icon]:hidden">
        <SidebarMenu>
          <ConversationGroupSkeleton canWrite dated />
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}
