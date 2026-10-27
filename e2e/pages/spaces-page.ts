// SPDX-License-Identifier: Apache-2.0

import { expect, type Page } from "@playwright/test";

/**
 * Page Object for the Spaces management page (/org-settings/spaces).
 */
export class SpacesPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto("/org-settings/spaces");
  }

  /**
   * The row of the space showing `name`. Found by its text, not by its cell's accessible name: a
   * row's cover button, named after the row, sits in that cell and doubles it ("Default Default").
   */
  private row(name: string) {
    return this.page.getByRole("row").filter({ has: this.page.getByText(name, { exact: true }) });
  }

  async waitForLoaded() {
    await expect(this.row("Default")).toBeVisible({ timeout: 10_000 });
  }

  /** The create-space modal, a second dialog over the settings overlay. */
  get createDialog() {
    return this.page.getByRole("dialog", { name: "Nouvel espace" });
  }

  /** Open the page's Actions menu, pick the create entry, and wait for the modal. */
  async openCreateModal() {
    await this.page.getByRole("button", { name: "Actions", exact: true }).click();
    await this.page.getByTestId("create-space-button").click();
    await expect(this.createDialog).toBeVisible();
  }

  /** Fill the name and submit the create space form. */
  async createSpace(name: string) {
    await this.openCreateModal();
    await this.page.locator("#space-create-name").fill(name);
    await this.page.getByTestId("space-create-submit").click();
    // Wait for modal to close (creation complete)
    await expect(this.createDialog).toHaveCount(0);
  }

  async expectSpaceVisible(name: string) {
    await expect(this.row(name)).toBeVisible({ timeout: 5_000 });
  }

  async expectDefaultBadgeVisible() {
    await expect(this.page.getByRole("cell", { name: "Par défaut" })).toBeVisible();
  }
}
