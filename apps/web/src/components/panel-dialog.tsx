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
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@appstrate/ui/components/dialog";
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@appstrate/ui/components/sheet";
import { keepOpenWhileRenaming } from "../lib/keep-open-while-renaming";
import { ErrorBoundary } from "./error-boundary";
import { ViewAsBanner } from "./view-as-banner";

interface PanelDialogProps {
  /** Announced to screen readers; the visible heading lives in `rail`. */
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
  onClose: () => void;
}

/** The rail on a phone. Remounted on every navigation, so picking an entry closes it. */
function PhoneNavigation({ title, rail }: { title: string; rail: ReactNode }) {
  const { t } = useTranslation("common");
  const { pathname } = useLocation();
  return (
    <Sheet key={pathname}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="mb-6 h-11 w-full justify-between bg-transparent px-3 md:hidden"
        >
          <span className="truncate">{t("panelDialog.menu")}</span>
          <ChevronDown className="size-4 shrink-0" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        aria-describedby={undefined}
        className="bg-sidebar flex w-[min(20rem,85vw)] flex-col gap-0 p-0"
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <ScrollArea className="min-h-0 flex-1">{rail}</ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

export function PanelDialog({ title, rail, contentHeader, children, onClose }: PanelDialogProps) {
  const { pathname } = useLocation();
  // Whether the pane has scrolled past its own top. Read off the scroll
  // container itself — the `ScrollArea` viewport, which is not reachable from
  // here by ref, found by walking up from a sentinel.
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
      {/* Only a handle on the scrolling pane. */}
      <div ref={attach} aria-hidden className="-mt-12 h-px" />
      <PhoneNavigation title={title} rail={rail} />
      {/* A page that crashes takes only the pane down: the rail stays, and
          picking another entry clears the error. */}
      <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onEscapeKeyDown={keepOpenWhileRenaming}
        className={[
          "flex h-[min(720px,calc(100dvh-6rem))] w-[min(1080px,calc(100vw-4rem))] max-w-none gap-0 overflow-hidden p-0",
          // Full screen on a phone: two panes side by side do not survive
          // 390px. The negative margin cancels the padding the shared dialog
          // wrapper puts around every content box.
          "max-sm:-m-4 max-sm:h-[100dvh] max-sm:w-[100vw] max-sm:rounded-none max-sm:border-0",
          // The header band owns the close control at every width.
          "[&>button]:top-1.5 [&>button]:right-1.5 [&>button]:z-30 [&>button]:flex [&>button]:size-11 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-md",
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
            Below `md` the rail moves into the phone's sheet. */}
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
