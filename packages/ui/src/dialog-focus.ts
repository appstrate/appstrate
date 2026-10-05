// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** Where focus returns when a state-opened dialog closes. Structural types: testable without a DOM. */

interface OpenerElement {
  isConnected: boolean;
  focus?: () => void;
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

interface FocusableElement {
  isConnected: boolean;
  focus?: () => void;
}

export interface DialogOpener {
  element: OpenerElement | null;
  /** Id of the menu trigger, when the dialog was opened from a menu item. */
  menuTriggerId: string | null;
}

/**
 * Record what had focus as the dialog opens (`<body>` counts as nothing), plus
 * the trigger of the enclosing menu: a menu item is unmounted by close time.
 */
export function captureDialogOpener(doc: {
  activeElement: OpenerElement | null;
  body: unknown;
}): DialogOpener {
  const active = doc.activeElement === doc.body ? null : doc.activeElement;
  return {
    element: active,
    menuTriggerId: active?.closest('[role="menu"]')?.getAttribute("aria-labelledby") ?? null,
  };
}

/** Focus the opener, else its menu's trigger; false when neither is left in the page. */
export function restoreDialogOpener(
  opener: DialogOpener,
  doc: { getElementById(id: string): FocusableElement | null },
): boolean {
  const target: FocusableElement | null = opener.element?.isConnected
    ? opener.element
    : opener.menuTriggerId
      ? doc.getElementById(opener.menuTriggerId)
      : null;
  if (!target?.isConnected || !target.focus) return false;
  target.focus();
  return true;
}
