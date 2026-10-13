// SPDX-License-Identifier: Apache-2.0

import type { paths } from "../api/client";
import type { ModelProviderCredentialInfo } from "../hooks/use-model-provider-credentials";

type PairingRequestBody =
  paths["/api/model-providers-oauth/pairing"]["post"]["requestBody"]["content"]["application/json"];

/**
 * What a pairing produces: a new subscription owned as `ownerType` says, or the
 * existing `credentialId` reconnected in place, whose owner the server knows.
 */
export type PairingTarget =
  | { ownerType: ModelProviderCredentialInfo["owner_type"]; credentialId?: never }
  | { credentialId: string; ownerType?: never };

/**
 * Body of `POST /api/model-providers-oauth/pairing`. A creation states
 * `owner_type` (the server's default, `org`, is not one a member may create); a
 * reconnect states `credentialId` alone, and the server refuses both together.
 */
export function pairingRequestBody(
  input: { providerId: string } & PairingTarget,
): PairingRequestBody {
  return input.credentialId !== undefined
    ? { providerId: input.providerId, credentialId: input.credentialId }
    : { providerId: input.providerId, owner_type: input.ownerType };
}

/**
 * Whether a usable subscription of `providerId` can serve organization models:
 * one the server lists as `bindable`, which a member's own is not.
 */
export function hasOrgSubscription(
  credentials:
    | readonly Pick<
        ModelProviderCredentialInfo,
        "authMode" | "providerId" | "bindable" | "needs_reconnection"
      >[]
    | undefined,
  providerId: string,
): boolean {
  return (credentials ?? []).some(
    (c) =>
      c.authMode === "oauth2" && c.providerId === providerId && c.bindable && !c.needs_reconnection,
  );
}
