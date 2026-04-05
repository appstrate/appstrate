// SPDX-License-Identifier: Apache-2.0

import { expect, type Page } from "@playwright/test";

/**
 * Page Object for the Webhooks page (/webhooks).
 */
export class WebhooksPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto("/webhooks");
  }

  /** Assert a webhook URL (without protocol) is visible on the page. */
  async expectWebhookVisible(fullUrl: string) {
    const urlHost = fullUrl.replace("https://", "");
    await expect(this.page.getByText(urlHost)).toBeVisible({ timeout: 10_000 });
  }
}
