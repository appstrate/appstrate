// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";

interface Opener {
  element: HTMLElement | null;
  menuTriggerId: string | null;
}

function readOpener(): Opener {
  const element =
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
  return {
    element,
    menuTriggerId: element?.closest('[role="menu"]')?.getAttribute("aria-labelledby") ?? null,
  };
}

/**
 * Where a state/URL dialog gives the focus back: the element that had it when the dialog opened
 * (such a dialog has no trigger of its own), or, when that element left the page with the menu
 * that held it, that menu's trigger. Spread on the dialog's content.
 *
 * The opener is read while the opening render runs: a field of the dialog that autofocuses takes
 * the focus at commit, before Base UI notes what had it.
 */
export function useDialogFocus(open: boolean) {
  const [opener, setOpener] = useState<Opener | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpener(readOpener());
  }
  return {
    finalFocus() {
      const target = opener?.element?.isConnected
        ? opener.element
        : opener?.menuTriggerId
          ? document.getElementById(opener.menuTriggerId)
          : null;
      return target?.isConnected ? target : true;
    },
  };
}
