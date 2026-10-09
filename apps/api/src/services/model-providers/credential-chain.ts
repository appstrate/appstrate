// SPDX-License-Identifier: Apache-2.0

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import type { Actor } from "@appstrate/connect";
import { actorFromIds } from "../../lib/actor.ts";
import { lookupCatalogModel } from "../model-catalog.ts";
import { personalModelCredentialsAllowed } from "./credentials.ts";
import { getModelProvider } from "./registry.ts";

/** The catalog family a provider's models belong to (a wrapper serves its catalog provider's ids). */
function familyOf(providerId: string): string {
  return getModelProvider(providerId)?.catalogProviderId ?? providerId;
}

/** Whether a personal credential of `credentialProviderId` may serve the model `target`. */
function servesModel(
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
export interface PersonalCredential {
  id: string;
  providerId: string;
  createdAt: Date;
}

/**
 * The personal credentials `payerUserId` owns in `orgId`, read once per call.
 * The owner query runs first (indexed, and almost always empty); the org policy
 * is read only when there is a credential to switch off.
 */
export async function listPersonalCredentials(
  orgId: string,
  payerUserId: string,
): Promise<PersonalCredential[]> {
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
 * before API keys, then oldest). Pure: no read, no policy.
 */
export function applicableCredentialIds(
  credentials: readonly PersonalCredential[],
  target: { providerId: string; modelId: string },
): string[] {
  const rank = (providerId: string): number =>
    getModelProvider(providerId)?.authMode === "oauth2" ? 0 : 1;
  return credentials
    .filter((credential) => servesModel(credential.providerId, target))
    .sort(
      (a, b) =>
        rank(a.providerId) - rank(b.providerId) || a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .map((credential) => credential.id);
}

/**
 * The user whose personal credentials may serve a run: its user actor, unless an
 * API key launched it (an API key spends no member's credential).
 */
export function runPayerUserId(run: {
  actor: Actor | null;
  apiKeyId?: string | null;
}): string | null {
  return run.actor?.type === "user" && !run.apiKeyId ? run.actor.id : null;
}

/** {@link runPayerUserId} of a run row: the same derivation wherever a run's payer is read. */
export function runPayerOf(run: {
  userId: string | null;
  endUserId: string | null;
  apiKeyId: string | null;
}): string | null {
  return runPayerUserId({ actor: actorFromIds(run.userId, run.endUserId), apiKeyId: run.apiKeyId });
}
