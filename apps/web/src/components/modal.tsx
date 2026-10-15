// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@appstrate/ui/components/dialog";
import { keepOpenWhileRenaming } from "../lib/keep-open-while-renaming";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  preventClose?: boolean;
  title: string;
  /** What the dialog does, read by assistive technology after the title. */
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function Modal({
  open,
  onClose,
  preventClose = false,
  title,
  description,
  children,
  actions,
  className,
}: ModalProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && !preventClose && onClose()}>
      <DialogContent
        className={className}
        onEscapeKeyDown={keepOpenWhileRenaming}
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        {actions && <DialogFooter>{actions}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
