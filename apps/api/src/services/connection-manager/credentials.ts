import { db } from "../../lib/db.ts";
import { logger } from "../../lib/logger.ts";
import { saveConnection } from "@appstrate/connect";

export async function saveApiKeyConnection(
  provider: string,
  apiKey: string,
  profileId: string,
  orgId: string,
): Promise<void> {
  await saveConnection(db, profileId, provider, orgId, { api_key: apiKey });

  logger.info("API key connection saved", { provider, profileId, orgId });
}

export async function saveCredentialsConnection(
  provider: string,
  authMode: "basic" | "custom",
  credentials: Record<string, string>,
  profileId: string,
  orgId: string,
): Promise<void> {
  await saveConnection(db, profileId, provider, orgId, credentials);

  logger.info("Credentials connection saved", { provider, authMode, profileId, orgId });
}
