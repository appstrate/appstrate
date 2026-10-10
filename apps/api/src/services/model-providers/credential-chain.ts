// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import type { AppEnv } from "../../types/index.ts";
import { isUserPrincipal } from "../../lib/principal.ts";
import { lookupCatalogModel } from "../model-catalog.ts";
import { personalModelCredentialsAllowed } from "./credentials.ts";
import { getModelProvider } from "./registry.ts";

/** The catalog family a provider's models belong to (a wrapper serves its catalog provider's ids). */
function familyOf(providerId: string): string {
  return getModelProvider(providerId)?.catalogProviderId ?? providerId;
}

/** A subscription (oauth2) credential: always personal, never served by the LLM proxy. */
function isSubscription(providerId: string): boolean {
  return getModelProvider(providerId)?.authMode === "oauth2";
}

/** Whether a personal credential of `credentialProviderId` may serve the model `target`. */
export function servesModel(
  credentialProviderId: string,
  target: { providerId: string; modelId: string },
): boolean {
  const def = getModelProvider(credentialProviderId);
  // No endpoint check: a personal credential never carries one (refused at creation).
  if (!def) return false;
  if (familyOf(credentialProviderId) !== familyOf(target.providerId)) return false;
  return lookupCatalogModel(def, target.modelId) !== null;
}

/** A member's personal credential, as applicability and ranking read it. */
interface PersonalCredential {
  id: string;
  providerId: string;
  createdAt: Date;
}

/**
 * The personal credentials `payerUserId` owns in `orgId` (none for `null`), read once per call.
 * The owner query runs first (indexed, and almost always empty); the org policy
 * is read only when there is a credential to switch off.
 */
export async function listPersonalCredentials(
  orgId: string,
  payerUserId: string | null,
): Promise<PersonalCredential[]> {
  if (!payerUserId) return [];
  const rows = await db
    .select({
      id: modelProviderCredentials.id,
      providerId: modelProviderCredentials.providerId,
      createdAt: modelProviderCredentials.createdAt,
    })
    .from(modelProviderCredentials)
    .where(
      and(
        eq(modelProviderCredentials.orgId, orgId),
        eq(modelProviderCredentials.ownerUserId, payerUserId),
      ),
    );
  if (rows.length === 0) return [];
  return (await personalModelCredentialsAllowed(orgId)) ? rows : [];
}

/**
 * The ids of the `credentials` that may serve `target`, best first (subscriptions
 * before API keys, then oldest). Pure: no read, no policy. `excludeSubscriptions`
 * drops the subscriptions (the LLM proxy never serves one).
 */
export function applicableCredentialIds(
  credentials: readonly PersonalCredential[],
  target: { providerId: string; modelId: string },
  options: { excludeSubscriptions?: boolean } = {},
): string[] {
  const rank = (providerId: string): number => (isSubscription(providerId) ? 0 : 1);
  return credentials
    .filter(
      (credential) =>
        !(options.excludeSubscriptions && isSubscription(credential.providerId)) &&
        servesModel(credential.providerId, target),
    )
    .sort(
      (a, b) =>
        rank(a.providerId) - rank(b.providerId) || a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .map((credential) => credential.id);
}

/**
 * The user whose personal credentials may serve a call of this request: the caller
 * when it is the platform user itself (see `isUserPrincipal`), never a delegate
 * (API key, third-party OAuth token) or an end user.
 */
export function requestPayerUserId(c: Context<AppEnv>): string | null {
  return isUserPrincipal(c) ? c.get("user").id : null;
}

/**
 * A member may own a credential of this provider, and a model on it may be left to
 * each member: its endpoint is fixed.
 */
export function providerAllowsPersonalCredentials(
  def: Pick<ModelProviderDefinition, "baseUrlOverridable">,
): boolean {
  return !def.baseUrlOverridable;
}

/**
 * An organization model may be bound to this credential: an organization API key,
 * never a member's own or a subscription.
 */
export function isBindableCredential(c: {
  ownerUserId: string | null;
  providerId: string;
}): boolean {
  return c.ownerUserId === null && !isSubscription(c.providerId);
}
