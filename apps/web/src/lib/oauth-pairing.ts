// SPDX-License-Identifier: Apache-2.0

import type { paths } from "../api/client";
import { isTransientError } from "../api/errors";
import type { ModelProviderCredentialInfo } from "../hooks/use-model-provider-credentials";

type PairingRequestBody =
  paths["/api/model-providers-oauth/pairing"]["post"]["requestBody"]["content"]["application/json"];

type PairingStatus =
  paths["/api/model-providers-oauth/pairing/{id}"]["get"]["responses"][200]["content"]["application/json"]["status"];

/** `lost`: the server refuses to state the pairing (row gone, or no longer readable). */
export type PairingPollState = PairingStatus | "lost";

/**
 * What a pairing produces: a new subscription owned as `ownerType` says, joining the
 * configuration `configId` (left out, the server finds or makes its family's), or `credentialId`
 * reconnected in place.
 */
export type PairingTarget =
  | {
      ownerType: ModelProviderCredentialInfo["owner_type"];
      configId?: string;
      credentialId?: never;
    }
  | { credentialId: string; ownerType?: never; configId?: never };

/**
 * Body of `POST /api/model-providers-oauth/pairing`. A creation states
 * `owner_type` (the server's default, `org`, is not one a member may create) and its
 * configuration when known; a reconnect states `credentialId` alone, and the server refuses a mix.
 */
export function pairingRequestBody(
  input: { providerId: string } & PairingTarget,
): PairingRequestBody {
  if (input.credentialId !== undefined) {
    return { providerId: input.providerId, credentialId: input.credentialId };
  }
  return {
    providerId: input.providerId,
    owner_type: input.ownerType,
    ...(input.configId ? { config_id: input.configId } : {}),
  };
}

// A refusal ends the poll even over a cached `pending`; a transient error changes nothing.
export function pairingPollState(
  status: PairingStatus | undefined,
  error: unknown,
): PairingPollState {
  if (error && !isTransientError(error)) return "lost";
  return status ?? "pending";
}

/** Whether the organization holds a usable subscription of `providerId` (a member's own is not one). */
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
