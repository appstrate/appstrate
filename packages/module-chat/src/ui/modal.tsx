// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal in-chat modal. A `fixed inset-0` overlay (no react-dom portal — the
 * package doesn't depend on react-dom; `position:fixed` already escapes the
 * scroll viewport since no chat ancestor establishes a transform/filter
 * containing block). Closes on backdrop click or Escape; locks body scroll
 * while open.
 */

import * as React from "react";
import { XIcon } from "lucide-react";

export function Modal({
  title,
  onClose,
  children,
}: React.PropsWithChildren<{ title: React.ReactNode; onClose: () => void }>) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Fermer"
        className="absolute inset-0 cursor-default bg-black/50"
        onClick={onClose}
      />
      <div className="bg-card text-card-foreground relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border shadow-lg">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
          <button
            type="button"
            aria-label="Fermer"
            className="text-muted-foreground hover:text-foreground shrink-0"
            onClick={onClose}
          >
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
