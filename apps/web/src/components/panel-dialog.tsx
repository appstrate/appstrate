// SPDX-License-Identifier: Apache-2.0

/**
 * Two-pane overlay (rail left, content right) for EXCURSIONS such as settings and
 * library browsing: floating keeps the screen underneath. Both panes scroll on their
 * own and the dialog itself never does (nested scrolling is what confuses).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { cn } from "@appstrate/ui/cn";
import { Dialog, DialogContent, DialogTitle } from "@appstrate/ui/components/dialog";
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import { keepOpenWhileRenaming } from "../lib/keep-open-while-renaming";
import { ErrorBoundary } from "./error-boundary";
import { PhoneNavigation } from "./phone-navigation";
import { ViewAsBanner } from "./view-as-banner";

interface PanelDialogProps {
  /** Announced to screen readers; the visible heading lives in `rail`. */
  title: string;
  /** The sections. Below `md` the rail moves into a sheet opened from a Menu button. */
  rail: ReactNode;
  /**
   * A band at the top of the content pane that STAYS while it scrolls, so content does
   * not slide under the floating close control. Invisible at rest; takes its background,
   * rule and, through `stuck`, the page name only once the pane has scrolled.
   */
  contentHeader: (stuck: boolean) => ReactNode;
  children: ReactNode;
  onClose: () => void;
}

export function PanelDialog({ title, rail, contentHeader, children, onClose }: PanelDialogProps) {
  const { pathname } = useLocation();
  // Whether the pane has scrolled past its top. The `ScrollArea` viewport is not reachable
  // by ref, so it is found by walking up from a sentinel.
  const [stuck, setStuck] = useState(false);
  // A callback ref: the node has to be caught when it attaches inside the dialog's portal.
  const [pane, setPane] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!pane) return;
    const read = () => setStuck(pane.scrollTop > 4);
    read();
    pane.addEventListener("scroll", read, { passive: true });
    return () => pane.removeEventListener("scroll", read);
  }, [pane]);
  // Stable, so React calls it on mount and unmount only, not on every commit.
  const attach = useCallback((node: HTMLDivElement | null) => {
    let scroller: HTMLElement | null = node?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    setPane(scroller);
  }, []);
  const content = (
    <div className="w-full max-w-full min-w-0 p-6 pt-0" style={{ contain: "inline-size" }}>
      {/* `-mx-6` cancels the pane's padding; `pr-14` keeps the close control's corner free. */}
      <div
        className={cn(
          "duration-fast sticky top-0 z-20 -mx-6 mb-12 px-6 py-3 pr-14 transition-colors",
          stuck && "bg-background border-b",
        )}
      >
        <div className="flex min-h-8 items-center">{contentHeader(stuck)}</div>
      </div>
      {/* Only a handle on the scrolling pane. */}
      <div ref={attach} aria-hidden className="-mt-12 h-px" />
      <PhoneNavigation title={title} rail={rail} className="md:hidden" />
      <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onEscapeKeyDown={keepOpenWhileRenaming}
        className={[
          "flex h-[min(720px,calc(100dvh-6rem))] w-[min(1080px,calc(100vw-4rem))] max-w-none gap-0 overflow-hidden p-0",
          // Full screen on a phone; the shared dialog's height cap is lifted with it.
          "max-sm:h-[100dvh] max-sm:max-h-none max-sm:w-[100vw] max-sm:rounded-none max-sm:border-0",
          // The header band owns the close control at every width.
          "[&>button]:top-1.5 [&>button]:right-1.5 [&>button]:z-30 [&>button]:flex [&>button]:size-11 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-md",
        ].join(" ")}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {/* The rail steps aside below `md`, not `sm`: at `sm` a 224px rail left the content
            304px, less than the 342px of a full-screen phone, and clipped settings tables. */}
        <aside className="bg-sidebar border-sidebar-border w-56 shrink-0 overflow-y-auto border-r max-md:hidden">
          {rail}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <ViewAsBanner inOverlay />
          <ScrollArea className="min-h-0 min-w-0 flex-1">{content}</ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
