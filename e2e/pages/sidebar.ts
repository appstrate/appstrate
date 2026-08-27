// SPDX-License-Identifier: Apache-2.0

import { expect, type Page } from "@playwright/test";

/**
 * Page Object for the sidebar navigation — org/space switcher and nav links.
 */
export class Sidebar {
  constructor(private page: Page) {}

  get switcherButton() {
    return this.page.getByTestId("org-switcher-button");
  }

  /** The dropdown menu container (for scoped locators). */
  get dropdownMenu() {
    return this.page.locator("[role='menu']");
  }

  get spaceSubmenuTrigger() {
    return this.page.getByTestId("space-submenu-trigger");
  }

  /** Open the org/space switcher dropdown and wait for it to render. */
  async openSwitcher() {
    await this.switcherButton.click();
    await expect(this.page.locator("[role='menu']")).toBeVisible();
  }

  /** Click an org by name in the switcher dropdown. */
  async switchOrg(orgName: string) {
    await this.openSwitcher();
    await this.page.getByText(orgName).click();
    // Organization changes always return to the dashboard.
    await expect(this.page).toHaveURL("/");
  }

  /** Open the space submenu and click a space by name. */
  async switchSpace(spaceName: string) {
    await this.openSwitcher();
    // Hover the space submenu trigger to open the sub-content
    await this.spaceSubmenuTrigger.hover();
    await expect(this.page.getByText(spaceName)).toBeVisible();
    await this.page.getByText(spaceName).click();
    // Wait for the space switch to take effect
    await this.page.waitForLoadState("domcontentloaded");
  }
}
