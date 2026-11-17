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
import { useDialogFocus } from "../hooks/use-dialog-focus";
import { INTEGRATED_TABLE_SURFACE } from "../lib/table-surface";
import { WorkingSpaceName } from "./space-name";

interface ModalProps {
  onClose: () => void;
  preventClose?: boolean;
  title: string;
  /** What the dialog does, read by assistive technology after the title. */
  description?: string;
  /**
   * The dialog acts in the working space (a creation, an import, a launch): in « Tous les
   * espaces » a line under its description names that space, the one the action that opened it
   * chose.
   */
  inSpace?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function Modal({
  onClose,
  preventClose = false,
  title,
  description,
  inSpace = false,
  children,
  actions,
  className,
}: ModalProps) {
  const focus = useDialogFocus();
  return (
    <Dialog open onOpenChange={(v) => !v && !preventClose && onClose()}>
      <DialogContent
        {...focus}
        {...INTEGRATED_TABLE_SURFACE}
        className={className}
        onEscapeKeyDown={keepOpenWhileRenaming}
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
          {inSpace && <WorkingSpaceName size="sm" className="text-muted-foreground" />}
        </DialogHeader>
        {children}
        {actions && <DialogFooter>{actions}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
