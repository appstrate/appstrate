// SPDX-License-Identifier: Apache-2.0

/**
 * The two panes of a panel overlay: a rail of sections on the left, content on
 * the right.
 *
 * The layout for surfaces that are EXCURSIONS rather than destinations — you go
 * in, change or pick one thing, and come back to where you were. Settings and
 * library browsing are both that. A route navigation would throw away the
 * screen underneath (its scroll, its filters, the page you were reading);
 * floating over it keeps them. The dialog itself is `OverlayFrame`'s, mounted
 * once above whatever these panes (or their skeleton) are.
 *
 * Both panes scroll on their own and the dialog itself never does. That is the
 * whole rule: nested scrolling is what makes these surfaces confusing, not
 * scrolling as such.
 */
import { useCallback, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { cn } from "@appstrate/ui/cn";
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import { ErrorBoundary } from "./error-boundary";
import { PhoneNavigation } from "./phone-navigation";
import { ViewAsBanner } from "./view-as-banner";

interface PanelLayoutProps {
  /** Announced to screen readers as the phone menu's title; the visible heading lives in `rail`. */
  title: string;
  /**
   * The sections. Below `md` two panes do not fit: the rail moves into a sheet
   * opened from a Menu button at the top of the content.
   */
  rail: ReactNode;
  /**
   * A band at the top of the content pane that STAYS while the pane scrolls.
   *
   * The dialog's close control floats over that pane, so without an opaque
   * band the content slides under it and the cross lands on whatever text
   * happens to be passing. At rest the band is invisible — the pane starts
   * with its own heading, and a second one plus a rule would be chrome nobody
   * asked for. It takes its background, its rule and, through `stuck`,
   * whatever names the page, only once the pane has scrolled.
   */
  contentHeader: (stuck: boolean) => ReactNode;
  children: ReactNode;
}

export function PanelLayout({ title, rail, contentHeader, children }: PanelLayoutProps) {
  const { pathname } = useLocation();
  const [stuck, setStuck] = useState(false);
  const attach = useCallback((viewport: HTMLDivElement | null) => {
    if (viewport) setStuck(viewport.scrollTop > 4);
  }, []);
  const content = (
    <div className="w-full max-w-full min-w-0 p-6 pt-0" style={{ contain: "inline-size" }}>
      {/* Sticky, and inset the way the pane is: `-mx-6` cancels the pane's
          padding so the band spans its full width, `pr-14` keeps the close
          control's corner free. */}
      <div
        className={cn(
          // Room under the band: the page below it starts with a title,
          // and a heading pinned to a bar reads as a label of that bar.
          "duration-fast sticky top-0 z-20 -mx-6 mb-12 px-6 py-3 pr-14 transition-colors",
          stuck && "bg-background border-b",
        )}
      >
        {/* One height for every caller, whether it draws a button or a
            title, so two panels leave the same room above their page. */}
        <div className="flex min-h-8 items-center">{contentHeader(stuck)}</div>
      </div>
      {/* Preserve the pane spacing independently of its scroll viewport. */}
      <div aria-hidden className="-mt-12 h-px" />
      <PhoneNavigation title={title} rail={rail} className="md:hidden" />
      {/* A page that crashes takes only the pane down: the rail stays, and
          picking another entry clears the error. */}
      <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
    </div>
  );

  return (
    <>
      {/* The rail steps aside below `md`, not below `sm`.
          At `sm` exactly, the dialog is `100vw - 4rem` = 576px and a 224px
          rail took 39% of it: the content pane was left 304px, LESS than the
          342px the same pane gets at a 390px window where the dialog goes
          full screen and the rail is gone. A settings table was therefore at
          its most cramped on a tablet rather than on a phone, and clipped 72
          pixels there — the widest overflow measured anywhere in the app.
          Below `md` the rail moves into the phone's sheet. */}
      <aside className="bg-sidebar border-sidebar-border w-56 shrink-0 overflow-y-auto border-r max-md:hidden">
        {rail}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <ViewAsBanner inOverlay />
        <ScrollArea
          className="min-h-0 min-w-0 flex-1"
          viewportProps={{
            ref: attach,
            onScroll: (event) => setStuck(event.currentTarget.scrollTop > 4),
          }}
        >
          {content}
        </ScrollArea>
      </div>
    </>
  );
}

/**
 * A message that stands in for the panes (access refused, address unknown): the
 * frame's box is a row, so it takes the width the panes would have had.
 */
export function PanelMessage({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-1 items-center justify-center">{children}</div>;
}
