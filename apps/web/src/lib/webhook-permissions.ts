// SPDX-License-Identifier: Apache-2.0

import type { GateablePermission } from "@/hooks/use-permissions";

/**
 * `webhooks` (space) and `org-webhooks` (org) are two resources; the ROW says
 * which one guards it, as the server resolves it (`loadWebhookForAction`).
 */
export function webhookResource(level: "org" | "space"): string {
  return level === "org" ? "org-webhooks" : "webhooks";
}

/** The webhooks page lists both levels, so holding either read opens it. */
export const WEBHOOK_READ_PERMISSIONS: GateablePermission[] = [
  `${webhookResource("space")}:read`,
  `${webhookResource("org")}:read`,
];
