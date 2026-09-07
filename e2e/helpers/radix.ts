// SPDX-License-Identifier: Apache-2.0

/**
 * Driving the Radix primitives the SPA builds its forms from.
 *
 * A Radix `Select` is a listbox, not a `<select>`, and its popper is taller
 * than the viewport without scrolling with the page — so an option far down it
 * is simply unclickable. Its typeahead is the way in: type enough of the label
 * to bring the option under the cursor, then commit it with Enter.
 */

import { expect, type Page } from "@playwright/test";

export async function selectOption(page: Page, triggerId: string, optionName: string) {
  const trigger = page.locator(`#${triggerId}`);
  const option = page.getByRole("option", { name: optionName, exact: true });
  await trigger.click();
  // The list must be mounted before typing, or the keystrokes go nowhere and
  // Enter commits whatever happens to be highlighted first.
  await expect(option).toBeVisible();
  await page.keyboard.type(optionName.split(" ")[0]!);
  await expect(option).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText(optionName);
}
