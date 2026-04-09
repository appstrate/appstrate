// SPDX-License-Identifier: Apache-2.0

import { expect, type Page } from "@playwright/test";

/**
 * Page Object for the Applications management page (/applications).
 */
export class ApplicationsPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto("/applications");
  }

  async waitForLoaded() {
    await expect(this.page.getByRole("heading", { name: "Default" })).toBeVisible({
      timeout: 10_000,
    });
  }

  /** Click the create application button and wait for the modal to open. */
  async openCreateModal() {
    await this.page.getByTestId("create-application-button").click();
    await expect(this.page.locator("[role='dialog']")).toBeVisible();
  }

  /** Fill the name and submit the create application form. */
  async createApplication(name: string) {
    await this.openCreateModal();
    await this.page.locator("#app-create-name").fill(name);
    await this.page.getByTestId("app-create-submit").click();
    // Wait for modal to close (creation complete)
    await expect(this.page.locator("[role='dialog']")).not.toBeVisible();
  }

  async expectAppVisible(name: string) {
    await expect(this.page.getByText(name)).toBeVisible({ timeout: 5_000 });
  }

  async expectDefaultBadgeVisible() {
    await expect(this.page.getByText("Par défaut")).toBeVisible();
  }
}
