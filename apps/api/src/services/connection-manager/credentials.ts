import { db } from "../../lib/db.ts";
import { logger } from "../../lib/logger.ts";
import { saveConnection } from "@appstrate/connect";
import { getProviderSnapshot } from "./helpers.ts";

export async function saveApiKeyConnection(
  provider: string,
  apiKey: string,
  profileId: string,
  orgId: string,
): Promise<void> {
  const { snapshot, configHash } = await getProviderSnapshot(orgId, provider);

  await saveConnection(
    db,
    profileId,
    provider,
    "api_key",
    { api_key: apiKey },
    snapshot,
    configHash,
  );

  logger.info("API key connection saved", { provider, profileId });
}

export async function saveCredentialsConnection(
  provider: string,
  authMode: "basic" | "custom" | "proxy",
  credentials: Record<string, string>,
  profileId: string,
  orgId: string,
): Promise<void> {
  const { snapshot, configHash } = await getProviderSnapshot(orgId, provider);

  await saveConnection(db, profileId, provider, authMode, credentials, snapshot, configHash);

  logger.info("Credentials connection saved", { provider, authMode, profileId });
}
