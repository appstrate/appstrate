// SPDX-License-Identifier: Apache-2.0

import { expect, type Locator, type Page } from "@playwright/test";

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
    // The item's accessible name is the space name followed by the role label,
    // so anchor the match: an unanchored "Default" also matches "Default 2".
    const escaped = spaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await this.clickSpaceItem(
      this.page.getByRole("menuitem", { name: new RegExp(`^${escaped}\\b`) }),
    );
  }

  /** Open the space submenu and click a space by id. */
  async switchSpaceById(spaceId: string) {
    await this.clickSpaceItem(this.page.getByTestId(`space-item-${spaceId}`));
  }

  private async clickSpaceItem(item: Locator) {
    await this.openSwitcher();
    // Click, not hover: a pointer already resting on the trigger when the menu
    // opens fires no `pointerenter`, and the sub-content never appears.
    await this.spaceSubmenuTrigger.click();
    await expect(item).toBeVisible();
    await item.click();
    await expect(this.dropdownMenu).toHaveCount(0);
  }
}
