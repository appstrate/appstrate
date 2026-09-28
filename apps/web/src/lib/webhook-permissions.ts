// SPDX-License-Identifier: Apache-2.0

/**
 * `webhooks` (space) and `org-webhooks` (org) are two resources; the ROW says
 * which one guards it, as the server resolves it (`loadWebhookForAction`).
 */
export function webhookResource(level: "org" | "space"): string {
  return level === "org" ? "org-webhooks" : "webhooks";
}
