// SPDX-License-Identifier: Apache-2.0

/**
 * Public types for the webhooks module — consumed by the API service layer
 * and the frontend via `@appstrate/shared-types`. The canonical definitions
 * live in `packages/shared-types/src/webhooks.ts` so they can be imported
 * from the frontend without crossing the module boundary.
 */

export type { WebhookInfo, WebhookCreateResponse, WebhookDelivery } from "@appstrate/shared-types";
