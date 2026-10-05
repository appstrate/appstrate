// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Where focus goes back to when a state-opened dialog closes.
 *
 * Structural types rather than DOM ones: the logic is two lookups, and typing
 * it on what it reads lets it be tested without a DOM.
 */

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
 * Record what had focus as the dialog opens. `<body>` holding focus means
 * nothing did, so there is nothing to give it back to. A menu item is
 * unmounted with its menu by the time the dialog closes, so the menu's own
 * trigger is recorded too: Radix labels the menu with it (`aria-labelledby`).
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

/**
 * Focus the opener if it is still in the page, else the trigger of the menu it
 * sat in. Returns false when neither is left (a deleted row's button): the
 * caller then keeps the platform default.
 */
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
