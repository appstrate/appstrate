// SPDX-License-Identifier: Apache-2.0

import { expect, type Page } from "@playwright/test";

/**
 * Page Object for the sidebar navigation — org/app switcher and nav links.
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

  get appSubmenuTrigger() {
    return this.page.getByTestId("app-submenu-trigger");
  }

  /** Open the org/app switcher dropdown and wait for it to render. */
  async openSwitcher() {
    await this.switcherButton.click();
    await expect(this.page.locator("[role='menu']")).toBeVisible();
  }

  /** Click an org by name in the switcher dropdown. */
  async switchOrg(orgName: string) {
    await this.openSwitcher();
    await this.page.getByText(orgName).click();
    // Wait for the org switch to take effect — agent list refetches
    await this.page.waitForLoadState("domcontentloaded");
  }

  /** Open the app submenu and click an app by name. */
  async switchApp(appName: string) {
    await this.openSwitcher();
    // Hover the app submenu trigger to open the sub-content
    await this.appSubmenuTrigger.hover();
    await expect(this.page.getByText(appName)).toBeVisible();
    await this.page.getByText(appName).click();
    // Wait for the app switch to take effect
    await this.page.waitForLoadState("domcontentloaded");
  }
}
