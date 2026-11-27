// SPDX-License-Identifier: Apache-2.0

/**
 * On a phone the navigation is a sheet over the page, and following one of its links folds it:
 * the sheet would only hide where the user went. The product tabs are the exception: they swap
 * the sheet's content (Studio's navigation, the chat's conversations) while the page behind moves
 * to that product's landing, so the user picks a section or a conversation without reopening it.
 * Their navigation carries this router state.
 */
export const KEEP_DRAWER_OPEN = { keepDrawerOpen: true } as const;

/** Whether a location's router state asks the phone's navigation sheet to stay open. */
export function keepsDrawerOpen(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as { keepDrawerOpen?: unknown }).keepDrawerOpen === true
  );
}
