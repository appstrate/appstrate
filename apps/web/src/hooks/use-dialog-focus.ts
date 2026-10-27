// SPDX-License-Identifier: Apache-2.0

import { useRef } from "react";

/** State/URL dialogs have no Radix Trigger; menu items may disappear before close. */
export function useDialogFocus() {
  const opener = useRef<{ element: HTMLElement | null; menuTriggerId: string | null } | null>(null);
  return {
    onOpenAutoFocus() {
      const element =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null;
      opener.current = {
        element,
        menuTriggerId: element?.closest('[role="menu"]')?.getAttribute("aria-labelledby") ?? null,
      };
    },
    onCloseAutoFocus(event: Event) {
      const captured = opener.current;
      const target = captured?.element?.isConnected
        ? captured.element
        : captured?.menuTriggerId
          ? document.getElementById(captured.menuTriggerId)
          : null;
      if (target?.isConnected) {
        event.preventDefault();
        target.focus();
      }
      opener.current = null;
    },
  };
}
