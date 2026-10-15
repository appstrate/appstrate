// SPDX-License-Identifier: Apache-2.0

/**
 * Two-pane overlay (rail left, content right) for EXCURSIONS such as settings and
 * library browsing: floating keeps the screen underneath. Both panes scroll on their
 * own and the dialog itself never does (nested scrolling is what confuses).
 */
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
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
   * A band at the top of the content pane that STAYS while it scrolls, on the pane's own
   * surface, so content does not slide under the floating close control.
   */
  contentHeader: ReactNode;
  children: ReactNode;
  onClose: () => void;
}

export function PanelDialog({ title, rail, contentHeader, children, onClose }: PanelDialogProps) {
  const { pathname } = useLocation();
  const content = (
    <div className="w-full max-w-full min-w-0 p-6 pt-0" style={{ contain: "inline-size" }}>
      {/* `-mx-6` cancels the pane's padding; `pr-14` keeps the close control's corner free. */}
      <div className="bg-background sticky top-0 z-20 -mx-6 px-6 py-3 pr-14">
        <div className="flex min-h-8 items-center">{contentHeader}</div>
      </div>
      <PhoneNavigation title={title} rail={rail} className="md:hidden" />
      <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onEscapeKeyDown={keepOpenWhileRenaming}
        // The header band owns the close control at every width.
        closeClassName="top-1.5 right-1.5 z-30 flex size-11 items-center justify-center rounded-md"
        className={[
          "flex h-[min(720px,calc(100dvh-6rem))] w-[min(1080px,calc(100vw-4rem))] max-w-none gap-0 overflow-hidden p-0",
          // Full screen on a phone; the shared dialog's height cap is lifted with it.
          "max-sm:h-[100dvh] max-sm:max-h-none max-sm:w-[100vw] max-sm:rounded-none max-sm:border-0",
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
