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
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@appstrate/ui/components/dialog";

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
  children: ReactNode;
  onClose: () => void;
}

export function PanelDialog({ title, rail, mobileNav, children, onClose }: PanelDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={[
          "flex h-[min(720px,calc(100dvh-6rem))] w-[min(1080px,calc(100vw-4rem))] max-w-none gap-0 overflow-hidden p-0",
          // Full screen on a phone: two panes side by side do not survive
          // 390px. The negative margin cancels the padding the shared dialog
          // wrapper puts around every content box.
          "max-sm:-m-4 max-sm:h-[100dvh] max-sm:w-[100vw] max-sm:rounded-none max-sm:border-0",
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
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {/* `pr-10` clears the dialog's own close button, which is absolutely
              positioned top-right and would otherwise sit on the selector. */}
          {mobileNav && <div className="mb-4 pr-10 md:hidden">{mobileNav}</div>}
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
