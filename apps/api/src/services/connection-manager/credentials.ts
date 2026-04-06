// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { logger } from "../../lib/logger.ts";
import { saveConnection, getProviderCredentialId } from "@appstrate/connect";

async function resolveProviderCredentialId(applicationId: string, provider: string) {
  const id = await getProviderCredentialId(db, applicationId, provider);
  if (!id)
    throw new Error(`No provider credentials for '${provider}' in application '${applicationId}'`);
  return id;
}

export async function saveApiKeyConnection(
  provider: string,
  apiKey: string,
  profileId: string,
  orgId: string,
  applicationId: string,
): Promise<void> {
  const providerCredentialId = await resolveProviderCredentialId(applicationId, provider);

  await saveConnection(
    db,
    profileId,
    provider,
    orgId,
    { api_key: apiKey },
    { providerCredentialId },
  );

  logger.info("API key connection saved", { provider, profileId, orgId });
}

export async function saveCredentialsConnection(
  provider: string,
  authMode: "basic" | "custom",
  credentials: Record<string, string>,
  profileId: string,
  orgId: string,
  applicationId: string,
): Promise<void> {
  const providerCredentialId = await resolveProviderCredentialId(applicationId, provider);

  await saveConnection(db, profileId, provider, orgId, credentials, { providerCredentialId });

  logger.info("Credentials connection saved", { provider, authMode, profileId, orgId });
}
