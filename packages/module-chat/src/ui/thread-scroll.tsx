// SPDX-License-Identifier: Apache-2.0

/**
 * The thread's one scroll. The transcript scrolls in assistant-ui's viewport, drawn as the design
 * system's `ScrollArea` viewport: the browser's scrollbar is hidden and the thin overlay one shows
 * instead. Its bar belongs to the area around the viewport, which the host may widen past the
 * thread (`ChatPage`'s `aside`): beside the context panel the bar stays at the window's edge, so the
 * page reads as one surface, not two columns split by a scrollbar.
 */

import { createContext, useContext, type ReactNode } from "react";
import { ThreadPrimitive } from "@assistant-ui/react";
import {
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollBar,
} from "@appstrate/ui/components/scroll-area";

const InThreadScrollArea = createContext(false);

/** The box the thread's scrollbar spans, its right edge the bar's. */
export function ThreadScrollArea({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <ScrollAreaRoot type="hover" className={className}>
      <InThreadScrollArea.Provider value>{children}</InThreadScrollArea.Provider>
      <ScrollBar />
    </ScrollAreaRoot>
  );
}

/**
 * assistant-ui's viewport as the area's (`THREAD_VIEWPORT_CLASS` lays out the box Radix wraps the
 * turns in). Rendered alone (a test, a host without an area), it brings its own area.
 */
export function ThreadViewport({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const inArea = useContext(InThreadScrollArea);
  const viewport = (
    <ThreadPrimitive.Viewport asChild>
      <ScrollAreaViewport className={className}>{children}</ScrollAreaViewport>
    </ThreadPrimitive.Viewport>
  );
  if (inArea) return viewport;
  return <ThreadScrollArea className="flex min-h-0 flex-1 flex-col">{viewport}</ThreadScrollArea>;
}
