// SPDX-License-Identifier: Apache-2.0

import type { PickerCredential } from "@appstrate/ui/components/model-picker-groups";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";

/**
 * The credentials that name a model picker's groups: the organization's (when the caller may
 * read them) and the caller's own. Another member's personal credential is dropped, it serves
 * none of the caller's calls. The upstream models a credential serves come from the provider
 * registry's catalog, the same lookup the server uses to pick the caller's credential.
 */
export function pickerCredentials(
  credentials: readonly ModelProviderCredentialInfo[],
  registry: readonly ProviderRegistryEntry[],
  userId: string | undefined,
): PickerCredential[] {
  return credentials.flatMap((credential) => {
    const own = credential.owner_type === "user";
    if (own && credential.owner_id !== userId) return [];
    return [
      {
        id: credential.id,
        label: credential.label,
        owner: own ? "me" : "org",
        subscription: credential.authMode === "oauth2",
        modelIds:
          registry
            .find((entry) => entry.providerId === credential.providerId)
            ?.models.map((model) => model.id) ?? [],
      },
    ];
  });
}
