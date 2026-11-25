// SPDX-License-Identifier: Apache-2.0

/**
 * Chat details use a wide, viewport-bounded design-system Dialog.
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
      <DialogContent className="flex max-h-[85dvh] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
          <DialogTitle className="min-w-0 truncate text-sm font-medium">{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
