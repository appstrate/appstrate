// SPDX-License-Identifier: Apache-2.0

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Page Object for the organisation and workspace switcher (`OrgSwitcher`).
 *
 * The switcher is a two-column popover: organisations on the left, the
 * workspaces of the organisation being explored on the right. Clicking an
 * organisation only explores it; a pick ends on a workspace, and org and
 * workspace are applied together.
 */
export class Sidebar {
  constructor(private page: Page) {}

  /**
   * The shell mounts the switcher twice (the sidebar's `brand` row and the
   * header's `mobile` chip, one of them hidden by the breakpoint), so only the
   * one on screen counts.
   */
  get switcherButton() {
    return this.page.getByTestId("org-switcher-button").locator("visible=true");
  }

  /** The switcher popover (for scoped locators). */
  get dropdownMenu() {
    return this.page.getByRole("dialog").filter({ has: this.page.getByTestId(/^org-item-/) });
  }

  /** Open the switcher and wait for it to render. */
  async openSwitcher() {
    await this.switcherButton.click();
    await expect(this.dropdownMenu).toBeVisible();
  }

  /** Explore an organisation by name, then pick one of its workspaces (the seeded "Default" one unless named). */
  async switchOrg(orgName: string, spaceName = "Default") {
    await this.openSwitcher();
    await this.dropdownMenu
      .getByTestId(/^org-item-/)
      .filter({ has: this.page.getByText(orgName, { exact: true }) })
      .click();
    await this.dropdownMenu
      .getByTestId(/^app-item-/)
      .filter({ has: this.page.getByText(spaceName, { exact: true }) })
      .click();
    await expect(this.dropdownMenu).toHaveCount(0);
    // Organization changes always return to the dashboard.
    await expect(this.page).toHaveURL("/");
  }

  /** Open the switcher and click a workspace of the current org by name. */
  async switchSpace(spaceName: string) {
    // Match the name on its own element, exactly: "Default" must not pick
    // "Default 2" or "My Default".
    await this.clickSpaceItem(
      this.dropdownMenu
        .getByTestId(/^app-item-/)
        .filter({ has: this.page.getByText(spaceName, { exact: true }) }),
    );
  }

  /** Open the switcher and click a workspace of the current org by id. */
  async switchSpaceById(spaceId: string) {
    await this.clickSpaceItem(this.page.getByTestId(`app-item-${spaceId}`));
  }

  private async clickSpaceItem(item: Locator) {
    await this.openSwitcher();
    await expect(item).toBeVisible();
    await item.click();
    await expect(this.dropdownMenu).toHaveCount(0);
  }

  /**
   * Switch workspace from inside the settings overlay. The overlay covers the
   * sidebar, so its rail carries the same choice as a context selector.
   */
  async switchSpaceInSettings(spaceName: string) {
    await this.page.getByRole("combobox", { name: "Choisir un espace de travail" }).click();
    await this.page.getByRole("option", { name: spaceName, exact: true }).click();
  }
}
