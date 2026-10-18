// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Skeleton } from "@appstrate/ui/components/skeleton";

/**
 * A saved conversation while its history loads: the turns it will show, in
 * place, above an inert composer frame of the live one's height. The runtime is
 * not mounted, so the frame is static markup, not the real composer.
 */
export function ConversationSkeleton({
  label,
  placeholder,
}: {
  label: string;
  /** The composer's placeholder; null for a reader, who gets no composer. */
  placeholder: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="flex size-full flex-col overflow-hidden"
    >
      {/* The thread's column (`--thread-max-width`, 42rem). */}
      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-6 px-4 pt-8">
        <Skeleton aria-hidden className="ml-auto h-10 w-2/5 rounded-2xl" />
        <div aria-hidden className="flex flex-col gap-2.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-3/5" />
        </div>
        <Skeleton aria-hidden className="ml-auto h-10 w-1/3 rounded-2xl" />
        <div aria-hidden className="flex flex-col gap-2.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-2/5" />
        </div>
      </div>
      {placeholder === null ? (
        // A reader's footer is the read-only note (`Composer`'s `chat:write` branch).
        <div aria-hidden className="mx-auto w-full max-w-2xl px-4 pb-4">
          <Skeleton className="h-[46px] w-full rounded-xl" />
        </div>
      ) : (
        <div aria-hidden className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pb-4">
          <div className="bg-card flex w-full flex-col gap-1 rounded-xl border px-3 py-2 shadow-sm">
            <div className="text-muted-foreground flex min-h-9 items-center py-1 text-sm">
              {placeholder}
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Skeleton className="size-8 rounded-lg" />
                <Skeleton className="h-7 w-32 rounded-md" />
              </div>
              <Skeleton className="size-8 rounded-lg" />
            </div>
          </div>
          {/* `Disclaimer`, the writer's line under the composer. */}
          <div className="flex h-4 justify-center">
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
      )}
    </div>
  );
}
