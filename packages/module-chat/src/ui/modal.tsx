// SPDX-License-Identifier: Apache-2.0

/**
 * In-chat modal — a thin composition over the design-system `Dialog`, which
 * already provides the portal, focus trap, Escape handling and body-scroll
 * lock this file used to hand-roll.
 *
 * The hand-rolled overlay was justified by "the package doesn't depend on
 * react-dom". That expired: the module imports Radix-backed `@appstrate/ui`
 * primitives (Popover, Tabs) whose peer set already includes react-dom, and
 * they resolve it from `packages/ui`, not from here.
 *
 * Only the sizing survives the move: chat details are wide and tall, hence the
 * `max-w-2xl` / `max-h-[85vh]` override on the design system's `max-w-lg`.
 */

import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@appstrate/ui/components/dialog";

export function Modal({
  title,
  onClose,
  children,
}: React.PropsWithChildren<{ title: React.ReactNode; onClose: () => void }>) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
          <DialogTitle className="min-w-0 truncate text-sm font-medium">{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
