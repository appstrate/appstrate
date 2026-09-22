// SPDX-License-Identifier: Apache-2.0

/**
 * Two-pane overlay: a rail of sections on the left, content on the right.
 *
 * The shell for surfaces that are EXCURSIONS rather than destinations — you go
 * in, change or pick one thing, and come back to where you were. Settings and
 * library browsing are both that. A route navigation would throw away the
 * screen underneath (its scroll, its filters, the page you were reading);
 * floating over it keeps them.
 *
 * Both panes scroll on their own and the dialog itself never does. That is the
 * whole rule: nested scrolling is what makes these surfaces confusing, not
 * scrolling as such.
 */
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";
import { Dialog, DialogContent, DialogTitle } from "@appstrate/ui/components/dialog";
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import { useIsMobile } from "@appstrate/ui/use-mobile";

interface PanelDialogProps {
  /** Announced to screen readers; the visible heading lives in `rail`. */
  title: string;
  rail: ReactNode;
  /**
   * Phone-sized stand-in for the rail, dropped at the top of the content pane.
   * Two panes side by side do not survive 390px, and a rail that eats 45% of
   * the width to list sections you are not reading is worse than a control that
   * collapses to one line.
   */
  mobileNav?: ReactNode;
  /** Use the design-system overlay scrollbar for this panel's content pane. */
  contentScrollArea?: boolean;
  /** Localized accessible name for the standard dialog close control. */
  closeLabel?: string;
  /** Keep page headings and toolbars below the dialog's close affordance. */
  reserveCloseArea?: boolean;
  /** Prototype the panel as a shell surface below the two-line mobile header. */
  mobileAsSurface?: boolean;
  /** Sticky action area owned by the content pane, never by the rail. */
  contentFooter?: ReactNode;
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
  contentHeader?: (stuck: boolean) => ReactNode;
  children: ReactNode;
  onClose: () => void;
}

export function PanelDialog({
  title,
  rail,
  mobileNav,
  contentScrollArea = false,
  closeLabel,
  reserveCloseArea = false,
  mobileAsSurface = false,
  contentFooter,
  contentHeader,
  children,
  onClose,
}: PanelDialogProps) {
  const isMobile = useIsMobile();
  // Whether the pane has scrolled past its own top. Read off the scroll
  // container itself — found by walking up from a sentinel, since the pane is
  // a `ScrollArea` viewport on one path and a plain overflow div on the other,
  // and neither is reachable from here by name.
  const [stuck, setStuck] = useState(false);
  // A callback ref rather than an object ref: the band is rendered inside the
  // dialog's portal, and the node has to be caught when it attaches there.
  const [pane, setPane] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!pane) return;
    const read = () => setStuck(pane.scrollTop > 4);
    read();
    pane.addEventListener("scroll", read, { passive: true });
    return () => pane.removeEventListener("scroll", read);
  }, [pane]);
  const attach = (node: HTMLDivElement | null) => {
    let scroller: HTMLElement | null = node?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    setPane(scroller);
  };
  const content = (
    <div
      className={cn(
        "w-full max-w-full min-w-0 p-6",
        // The band reserves the close control's room itself.
        reserveCloseArea && !contentHeader && "md:pt-14",
        contentHeader && "pt-0",
      )}
      style={{ contain: "inline-size" }}
    >
      {/* `pr-10` clears the dialog's own close button, which is absolutely
          positioned top-right and would otherwise sit on the selector. */}
      {contentHeader && (
        <>
          {/* Sticky, and inset the way the pane is: `-mx-6` cancels the pane's
              padding so the band spans its full width, `pr-14` keeps the close
              control's corner free. */}
          <div
            className={cn(
              "sticky top-0 z-20 -mx-6 mb-4 px-6 py-2 pr-14 transition-colors duration-200",
              stuck && "bg-background border-b",
            )}
          >
            {contentHeader(stuck)}
          </div>
          {/* Only a handle on the scrolling pane. */}
          <div ref={attach} aria-hidden className="-mt-4 h-px" />
        </>
      )}
      {mobileNav && <div className="mb-4 pr-10 md:hidden">{mobileNav}</div>}
      {children}
    </div>
  );

  if (mobileAsSurface && isMobile) {
    return (
      <section
        data-settings-mobile-surface
        aria-label={title}
        className="bg-background fixed inset-x-0 top-24 bottom-0 z-10 flex min-w-0 flex-col overflow-hidden"
      >
        {contentScrollArea ? (
          <ScrollArea className="min-h-0 min-w-0 flex-1">{content}</ScrollArea>
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{content}</div>
        )}
      </section>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        closeLabel={closeLabel}
        className={[
          "flex h-[min(720px,calc(100dvh-6rem))] w-[min(1080px,calc(100vw-4rem))] max-w-none gap-0 overflow-hidden p-0",
          // Full screen on a phone: two panes side by side do not survive
          // 390px. The negative margin cancels the padding the shared dialog
          // wrapper puts around every content box.
          "max-sm:-m-4 max-sm:h-[100dvh] max-sm:w-[100vw] max-sm:rounded-none max-sm:border-0",
          // The reserved header band owns the close control at every modal
          // width. Other panels keep the existing phone-sized target only.
          reserveCloseArea
            ? "[&>button]:top-1.5 [&>button]:right-1.5 [&>button]:z-30 [&>button]:flex [&>button]:size-11 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-md"
            : "max-md:[&>button]:top-2.5 max-md:[&>button]:right-2.5 max-md:[&>button]:z-30 max-md:[&>button]:flex max-md:[&>button]:size-11 max-md:[&>button]:items-center max-md:[&>button]:justify-center",
        ].join(" ")}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {/* The rail steps aside below `md`, not below `sm`.
            At `sm` exactly, the dialog is `100vw - 4rem` = 576px and a 224px
            rail took 39% of it: the content pane was left 304px, LESS than the
            342px the same pane gets at a 390px window where the dialog goes
            full screen and the rail is gone. A settings table was therefore at
            its most cramped on a tablet rather than on a phone, and clipped 72
            pixels there — the widest overflow measured anywhere in the app.
            Below `md` the nav becomes the select at the top of the content,
            which is the same answer the phone already gave. */}
        <aside className="bg-sidebar border-sidebar-border w-56 shrink-0 overflow-y-auto border-r max-md:hidden">
          {rail}
        </aside>
        {contentScrollArea ? (
          <div className="flex min-w-0 flex-1 flex-col">
            <ScrollArea className="min-h-0 min-w-0 flex-1">{content}</ScrollArea>
            {contentFooter}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>
            {contentFooter}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
