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

/**
 * Response from `POST /api/webhooks/:id/rotate`.
 *
 * `secret` is the freshly-minted next secret (consumer should migrate
 * to it). `secretPrevious` is the value that was on the row before
 * rotation — it remains valid for delivery verification until
 * `rotationWindowEndsAt`. After the window closes, the next delivery
 * inline-promotes the new secret and the previous one is retired.
 */
export interface WebhookRotateResponse {
  secret: string;
  secretPrevious: string;
  rotationWindowEndsAt: string;
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
