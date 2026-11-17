// SPDX-License-Identifier: Apache-2.0

/**
 * Driving the settings tables: a row has one way to act, its
 * « … » menu (`TableRowActions`), whose button is named « Plus d'actions pour
 * <row name> »; and one way to open it, {@link openRow}.
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

/**
 * Open a table row by pressing its name. The row's cover button is stretched over the whole row,
 * and its centre may lie under a control of another column (a switch), so it is not the one to
 * press; the row opens on a click anywhere on it that is not a control.
 */
export async function openRow(page: Page, rowName: string): Promise<void> {
  await page
    .getByRole("row")
    .filter({ hasText: rowName })
    .getByText(rowName, { exact: true })
    .click();
}
