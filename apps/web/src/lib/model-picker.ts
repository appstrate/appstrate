// SPDX-License-Identifier: Apache-2.0

import type { PickerCredential } from "@appstrate/ui/components/model-picker-groups";
import type { ModelProviderCredentialInfo } from "../hooks/use-model-provider-credentials";

/**
 * The caller's own connections, which name the picker's personal groups and tell a dead key from
 * none. The organization's name nothing (an organization group is named by its configuration) and
 * another member's serves none of the caller's calls. The models a connection serves are the
 * server's (`serves_model_ids`, the organization's model rows).
 */
export function pickerCredentials(
  credentials: readonly ModelProviderCredentialInfo[],
  userId: string | undefined,
): PickerCredential[] {
  return credentials
    .filter((credential) => credential.owner_type === "user" && credential.owner_id === userId)
    .map((credential) => ({
      id: credential.id,
      label: credential.label,
      configId: credential.config_id,
      subscription: credential.authMode === "oauth2",
      needsReconnection: credential.needs_reconnection === true,
      modelIds: credential.serves_model_ids,
    }));
}
