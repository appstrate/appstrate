// SPDX-License-Identifier: Apache-2.0

import type { paths } from "../api/client";
import type { ModelProviderCredentialInfo } from "../hooks/use-model-provider-credentials";

type PairingRequestBody =
  paths["/api/model-providers-oauth/pairing"]["post"]["requestBody"]["content"]["application/json"];

export type CredentialOwnerType = ModelProviderCredentialInfo["owner_type"];

/**
 * Body of `POST /api/model-providers-oauth/pairing`. `owner_type` is always sent:
 * the server defaults it to `org`, which a member pairing their own subscription
 * may not create. With `credentialId` (a reconnect) it names that credential's owner.
 */
export function pairingRequestBody(input: {
  providerId: string;
  ownerType: CredentialOwnerType;
  credentialId?: string;
}): PairingRequestBody {
  return {
    providerId: input.providerId,
    owner_type: input.ownerType,
    ...(input.credentialId ? { credentialId: input.credentialId } : {}),
  };
}

/** Whether the organization holds a usable subscription of `providerId`; a member's own is not one. */
export function hasOrgSubscription(
  credentials:
    | readonly Pick<
        ModelProviderCredentialInfo,
        "authMode" | "providerId" | "owner_type" | "needs_reconnection"
      >[]
    | undefined,
  providerId: string,
): boolean {
  return (credentials ?? []).some(
    (c) =>
      c.authMode === "oauth2" &&
      c.providerId === providerId &&
      c.owner_type === "org" &&
      !c.needs_reconnection,
  );
}
