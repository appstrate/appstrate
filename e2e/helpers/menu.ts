// SPDX-License-Identifier: Apache-2.0

import type { Page } from "@playwright/test";

/**
 * A menu's item, on every format: a dropdown's `menuitem` from `md` up, a row (a button) of the
 * bottom sheet the same `DropdownMenu` draws below it (`packages/ui` `SheetMenuContent`).
 */
export function menuItem(page: Page, name: string | RegExp, options: { exact?: boolean } = {}) {
  return page
    .getByRole("menuitem", { name, ...options })
    .or(page.getByTestId("sheet-menu").getByRole("button", { name, ...options }));
}
