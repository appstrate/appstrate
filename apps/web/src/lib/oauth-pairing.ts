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

/** A refusal ends the poll even over a cached `pending`; a transient error changes nothing. */
export function pairingPollState(
  status: PairingStatus | undefined,
  error: unknown,
): PairingPollState {
  if (error && !isTransientError(error)) return "lost";
  return status ?? "pending";
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
