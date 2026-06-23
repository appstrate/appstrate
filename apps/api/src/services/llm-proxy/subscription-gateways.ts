// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-id → subscription SDK gateway handler registry.
 *
 * Each subscription provider whose chat surface runs through an
 * `/api/llm-proxy/<providerId>-sdk/:presetId/*` credential-injection gateway
 * registers its handler here, keyed by PROVIDER ID. The llm-proxy router then
 * mounts the gateway routes DATA-DRIVEN: it iterates the contributed
 * subscription-engine registry (`listSubscriptionEngines()`), and for every
 * engine flagged `chatGateway` it looks up the handler by provider id here.
 *
 * Why this indirection: the previous wiring hardcoded `{ claude: handler }`
 * keyed by engine in the router, so adding a chat-capable engine meant editing
 * the router. With a provider-id-keyed registry the router has ZERO vendor
 * literals — a new gateway provider self-registers its handler here (next to its
 * implementation) and sets `chatGateway` on its engine binding; the router needs
 * no edit. The handler stays in apps/api (it is platform llm-proxy infra that
 * uses Hono internals) rather than moving into the provider module, which would
 * force the module to import platform framework types.
 */

import type { Context } from "hono";
import type { AppEnv } from "../../types/index.ts";

/**
 * A subscription gateway handler: forwards the SDK's request to the upstream
 * with the placeholder bearer swapped for the real subscription token. Receives
 * the Hono context + the request-body byte cap.
 */
export type SubscriptionGatewayHandler = (
  c: Context<AppEnv>,
  maxBytes: number,
) => Promise<Response>;

const BY_PROVIDER = new Map<string, SubscriptionGatewayHandler>();

/**
 * Register a subscription SDK gateway handler for a provider id. Idempotent for
 * an identical re-registration (module-import side effects can run more than
 * once); throws on a CONFLICTING handler for the same provider id.
 */
export function registerSubscriptionGateway(
  providerId: string,
  handler: SubscriptionGatewayHandler,
): void {
  const existing = BY_PROVIDER.get(providerId);
  if (existing && existing !== handler) {
    throw new Error(
      `Subscription gateway for provider ${JSON.stringify(providerId)} is already registered.`,
    );
  }
  BY_PROVIDER.set(providerId, handler);
}

/** The gateway handler for a provider id, or `undefined` when none is registered. */
export function subscriptionGatewayFor(providerId: string): SubscriptionGatewayHandler | undefined {
  return BY_PROVIDER.get(providerId);
}
