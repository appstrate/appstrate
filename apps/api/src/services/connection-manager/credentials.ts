// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { logger } from "../../lib/logger.ts";
import { saveConnection } from "@appstrate/connect";
import { resolveProviderCredentialId } from "./helpers.ts";

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
