// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../../types/index.ts";
import { isUserPrincipal } from "../../lib/principal.ts";
import { lookupCatalogModel, piProviderOf, restrictsToOffer } from "../model-catalog.ts";
import { getModelProvider } from "./registry.ts";

/** The catalog family a provider's models belong to (a wrapper serves its catalog provider's ids). */
function familyOf(providerId: string): string {
  return getModelProvider(providerId)?.catalogProviderId ?? providerId;
}

/**
 * The provider a configuration of `providerId`'s family is stored under: the family's own
 * registered provider when there is one (`claude-code` → `anthropic`), else `providerId`
 * itself (`codex`, whose family `openai-codex` is no registered provider).
 */
export function configProviderOf(providerId: string): string {
  const family = familyOf(providerId);
  return getModelProvider(family) ? family : providerId;
}

/** A provider whose endpoint is chosen per configuration (`baseUrlOverridable`). */
export function isGatewayProvider(providerId: string): boolean {
  return getModelProvider(providerId)?.baseUrlOverridable === true;
}

/**
 * Whether a connection of `connectionProviderId` may join a configuration of
 * `configProviderId`: the same catalog family, and for a gateway the same provider.
 */
export function connectionFitsConfig(
  connectionProviderId: string,
  configProviderId: string,
): boolean {
  if (!getModelProvider(connectionProviderId)) return false;
  if (familyOf(connectionProviderId) !== familyOf(configProviderId)) return false;
  return !isGatewayProvider(configProviderId) || connectionProviderId === configProviderId;
}

/**
 * Whether a connection of `connectionProviderId` serves `modelId` of a configuration of
 * `configProviderId`: it fits, and the model is in its offer (a gateway, or a provider not
 * restricted to its offer, serves any id). A subscription serves only its catalog's ids.
 */
export function servesModel(
  connectionProviderId: string,
  configProviderId: string,
  modelId: string,
): boolean {
  if (!connectionFitsConfig(connectionProviderId, configProviderId)) return false;
  const def = getModelProvider(connectionProviderId)!;
  if (piProviderOf(def) === null) return true;
  return lookupCatalogModel(def, modelId) !== null || !restrictsToOffer(def);
}

/** A subscription (oauth2) connection: never served by the LLM proxy, first in its rank. */
function isSubscription(providerId: string): boolean {
  return getModelProvider(providerId)?.authMode === "oauth2";
}

/** A connection of a configuration, as the serving order reads it. */
export interface ConnectionCandidate {
  id: string;
  providerId: string;
  ownerUserId: string | null;
  createdAt: Date;
}

/** Who asks for a model of a configuration, and how. */
export interface CandidateQuery {
  /** The configuration's provider. */
  configProviderId: string;
  personalConnectionsAllowed: boolean;
  modelId: string;
  /** An alias is served by the organization only, never by a subscription. */
  aliased: boolean;
  /** The member whose personal connections may serve (`null`: none). */
  payerUserId: string | null;
  /** The LLM proxy never serves a subscription. */
  viaProxy?: boolean;
}

/**
 * The connections that may serve the model, best first: personal subscription, personal
 * API key, organization subscription, organization API key, then oldest. Pure: no read.
 * `connections` are the configuration's; a member's personal ones count for that member
 * only, while the configuration allows them and the model is no alias.
 */
export function rankCandidates<T extends ConnectionCandidate>(
  connections: readonly T[],
  query: CandidateQuery,
): T[] {
  const personalOk =
    query.payerUserId !== null && query.personalConnectionsAllowed && !query.aliased;
  const rank = (c: T): number =>
    (c.ownerUserId === null ? 2 : 0) + (isSubscription(c.providerId) ? 0 : 1);
  return connections
    .filter(
      (c) =>
        (c.ownerUserId === null || (personalOk && c.ownerUserId === query.payerUserId)) &&
        // A subscription is a bearer swap: neither the proxy nor an alias's body rewrite runs on one.
        !((query.viaProxy || query.aliased) && isSubscription(c.providerId)) &&
        servesModel(c.providerId, query.configProviderId, query.modelId),
    )
    .sort((a, b) => rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * The user whose personal credentials may serve a call of this request: the caller
 * when it is the platform user itself (see `isUserPrincipal`), never a delegate
 * (API key, third-party OAuth token) or an end user.
 */
export function requestPayerUserId(c: Context<AppEnv>): string | null {
  return isUserPrincipal(c) ? c.get("user").id : null;
}
