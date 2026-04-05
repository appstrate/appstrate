// SPDX-License-Identifier: Apache-2.0

import { expect, type Page } from "@playwright/test";

/**
 * Page Object for the Agents list page (/agents).
 */
export class AgentsPage {
  constructor(private page: Page) {}

  /** Navigate to the agents page and wait for content to load. */
  async goto() {
    await this.page.goto("/agents");
  }

  /** Wait for the page heading to appear (signals React has rendered). */
  async waitForLoaded() {
    await expect(this.page.getByRole("heading", { name: /agents/i })).toBeVisible({
      timeout: 10_000,
    });
  }

  /** Assert an agent is visible by partial name match. */
  async expectAgentVisible(name: string) {
    await expect(this.page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
  }

  /** Assert an agent is NOT visible by partial name match. */
  async expectAgentNotVisible(name: string) {
    await expect(this.page.getByText(name).first()).not.toBeVisible();
  }
}
