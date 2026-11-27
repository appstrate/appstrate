// SPDX-License-Identifier: Apache-2.0

import { useRef } from "react";

/**
 * Where a state/URL dialog gives the focus back: the element that had it when the dialog opened
 * (such a dialog has no trigger of its own), or, when that element left the page with the menu
 * that held it, that menu's trigger. Spread on the dialog's content.
 */
export function useDialogFocus() {
  const opener = useRef<{ element: HTMLElement | null; menuTriggerId: string | null } | null>(null);
  return {
    initialFocus() {
      const element =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null;
      opener.current = {
        element,
        menuTriggerId: element?.closest('[role="menu"]')?.getAttribute("aria-labelledby") ?? null,
      };
      return true;
    },
    finalFocus() {
      const captured = opener.current;
      opener.current = null;
      const target = captured?.element?.isConnected
        ? captured.element
        : captured?.menuTriggerId
          ? document.getElementById(captured.menuTriggerId)
          : null;
      return target?.isConnected ? target : true;
    },
  };
}
