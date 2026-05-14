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
  connectionProfileId: string,
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
    connectionProfileId,
    provider,
    scope.orgId,
    { [fieldName]: apiKey },
    { providerCredentialId },
  );

  logger.info("API key connection saved", {
    provider,
    connectionProfileId,
    orgId: scope.orgId,
    fieldName,
  });
}

export async function saveCredentialsConnection(
  scope: AppScope,
  provider: string,
  authMode: "basic" | "custom" | "password",
  credentials: Record<string, string>,
  connectionProfileId: string,
): Promise<void> {
  const providerCredentialId = await resolveProviderCredentialId(scope.applicationId, provider);

  // For password (ROPC) connections the platform stores username +
  // password as-is; the first `getCredentials()` call lazily bootstraps
  // an access_token via the upstream token endpoint and persists the
  // result. We deliberately don't bootstrap synchronously at connect
  // time — the dashboard "Connect" button stays fast and a wrong token
  // endpoint surfaces as a clear "couldn't fetch a token" error the
  // next time the agent runs instead of swallowing the first call's
  // latency or partial-failing the connection row.
  await saveConnection(db, connectionProfileId, provider, scope.orgId, credentials, {
    providerCredentialId,
  });

  logger.info("Credentials connection saved", {
    provider,
    authMode,
    connectionProfileId,
    orgId: scope.orgId,
  });
}
