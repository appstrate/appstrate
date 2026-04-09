// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { getProviderCredentialId } from "@appstrate/connect";

/**
 * Resolve the credential ID for a provider in an application, or throw.
 * Shared by oauth.ts and credentials.ts.
 */
export async function resolveProviderCredentialId(
  applicationId: string,
  providerId: string,
): Promise<string> {
  const id = await getProviderCredentialId(db, applicationId, providerId);
  if (!id)
    throw new Error(
      `No provider credentials for '${providerId}' in application '${applicationId}'`,
    );
  return id;
}

/** Map provider authMode to the uppercase label exposed in API responses. */
export function authModeLabel(authMode: string | undefined): string {
  switch (authMode) {
    case "api_key":
      return "API_KEY";
    case "oauth1":
      return "OAUTH1";
    default:
      return "OAUTH2";
  }
}
