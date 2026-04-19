// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { logger } from "../../lib/logger.ts";
import { getCredentialFieldName, getProviderOrThrow, saveConnection } from "@appstrate/connect";
import { resolveProviderCredentialId } from "./helpers.ts";
import type { AppScope } from "../../lib/scope.ts";

export async function saveApiKeyConnection(
  scope: AppScope,
  provider: string,
  apiKey: string,
  profileId: string,
): Promise<void> {
  // Fire both lookups concurrently — they hit independent tables
  // (applicationProviderCredentials vs packages) and neither depends on the
  // other. Avoids adding a sequential round-trip on the connect hot path.
  const [providerCredentialId, providerDef] = await Promise.all([
    resolveProviderCredentialId(scope.applicationId, provider),
    getProviderOrThrow(db, scope.orgId, provider),
  ]);

  // Store the key under the field name declared by the provider (defaults to
  // "api_key" for api_key mode). This must match the key the sidecar resolves
  // at request time via buildSidecarCredentials — otherwise {{field}} stays
  // unsubstituted in outbound headers.
  const fieldName = getCredentialFieldName(providerDef);

  await saveConnection(
    db,
    profileId,
    provider,
    scope.orgId,
    { [fieldName]: apiKey },
    { providerCredentialId },
  );

  logger.info("API key connection saved", {
    provider,
    profileId,
    orgId: scope.orgId,
    fieldName,
  });
}

export async function saveCredentialsConnection(
  scope: AppScope,
  provider: string,
  authMode: "basic" | "custom",
  credentials: Record<string, string>,
  profileId: string,
): Promise<void> {
  const providerCredentialId = await resolveProviderCredentialId(scope.applicationId, provider);

  await saveConnection(db, profileId, provider, scope.orgId, credentials, {
    providerCredentialId,
  });

  logger.info("Credentials connection saved", {
    provider,
    authMode,
    profileId,
    orgId: scope.orgId,
  });
}
