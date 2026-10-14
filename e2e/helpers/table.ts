// SPDX-License-Identifier: Apache-2.0

/**
 * Driving the settings tables: a row has one way to act, its
 * « … » menu (`TableRowActions`), whose button is named « Plus d'actions pour
 * <row name> ».
 */

import type { Page } from "@playwright/test";

/** A row's « … » menu entry, opened by the row's own button (« Plus d'actions pour <name> »). */
export async function openRowMenuItem(
  page: Page,
  rowName: RegExp | string,
  item: string,
): Promise<void> {
  await page
    .getByRole("row")
    .filter({ hasText: rowName })
    .getByRole("button", { name: /^Plus d.actions pour/ })
    .click();
  await page.getByRole("menuitem", { name: item }).click();
}
