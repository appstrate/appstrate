// SPDX-License-Identifier: Apache-2.0

import type { PickerCredential } from "@appstrate/ui/components/model-picker-groups";
import type { ModelProviderCredentialInfo } from "../hooks/use-model-provider-credentials";

/**
 * The credentials that name a model picker's groups: the organization's (when the caller may
 * read them) and the caller's own. Another member's personal credential is dropped, it serves
 * none of the caller's calls. The models a credential serves are the server's
 * (`serves_model_ids`, the organization's model rows).
 */
export function pickerCredentials(
  credentials: readonly ModelProviderCredentialInfo[],
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
        modelIds: credential.serves_model_ids,
      },
    ];
  });
}
