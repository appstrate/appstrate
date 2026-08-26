// SPDX-License-Identifier: Apache-2.0

import { expect, type Page } from "@playwright/test";

/**
 * Page Object for the Spaces management page (/spaces).
 */
export class SpacesPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto("/spaces");
  }

  async waitForLoaded() {
    await expect(this.page.getByRole("heading", { name: "Default" })).toBeVisible({
      timeout: 10_000,
    });
  }

  /** Click the create space button and wait for the modal to open. */
  async openCreateModal() {
    await this.page.getByTestId("create-space-button").click();
    await expect(this.page.locator("[role='dialog']")).toBeVisible();
  }

  /** Fill the name and submit the create space form. */
  async createSpace(name: string) {
    await this.openCreateModal();
    await this.page.locator("#space-create-name").fill(name);
    await this.page.getByTestId("space-create-submit").click();
    // Wait for modal to close (creation complete)
    await expect(this.page.locator("[role='dialog']")).not.toBeVisible();
  }

  async expectSpaceVisible(name: string) {
    await expect(this.page.getByText(name)).toBeVisible({ timeout: 5_000 });
  }

  async expectDefaultBadgeVisible() {
    await expect(this.page.getByText("Par défaut")).toBeVisible();
  }
}
