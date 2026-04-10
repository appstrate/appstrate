// SPDX-License-Identifier: Apache-2.0

/**
 * Public types for the webhooks module.
 *
 * Lives under `shared-types/modules/webhooks.ts` as a naming boundary:
 * these types belong to the module, not to the core platform. They are
 * re-exported from the shared-types barrel so frontend code that already
 * imports from `@appstrate/shared-types` keeps working, and so the eventual
 * extraction of `@appstrate/webhooks-types` is mechanical.
 */

export interface WebhookInfo {
  id: string;
  object: "webhook";
  applicationId: string;
  url: string;
  events: string[];
  packageId: string | null;
  payloadMode: "full" | "summary";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookCreateResponse extends WebhookInfo {
  secret: string;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  status: "pending" | "success" | "failed";
  statusCode: number | null;
  latency: number | null;
  attempt: number;
  error: string | null;
  createdAt: string;
}
