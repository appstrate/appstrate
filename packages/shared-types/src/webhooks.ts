// SPDX-License-Identifier: Apache-2.0

/**
 * Public types for the webhooks module — shared between the API service
 * layer and the frontend. Defined here (not in `apps/api/src/modules/webhooks`)
 * because the frontend cannot cross the module boundary to import from the API.
 */

export interface WebhookInfo {
  id: string;
  object: "webhook";
  level: "org" | "application";
  applicationId: string | null;
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
