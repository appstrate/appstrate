// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@appstrate/ui/components/dialog";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  preventClose?: boolean;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function Modal({
  open,
  onClose,
  preventClose = false,
  title,
  children,
  actions,
  className,
}: ModalProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && !preventClose && onClose()}>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
        {actions && <DialogFooter>{actions}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
