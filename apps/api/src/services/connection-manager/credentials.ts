import { db } from "../../lib/db.ts";
import { logger } from "../../lib/logger.ts";
import { saveConnection } from "@appstrate/connect";

export async function saveApiKeyConnection(
  provider: string,
  apiKey: string,
  profileId: string,
): Promise<void> {
  await saveConnection(db, profileId, provider, { api_key: apiKey });

  logger.info("API key connection saved", { provider, profileId });
}

export async function saveCredentialsConnection(
  provider: string,
  authMode: "basic" | "custom" | "proxy",
  credentials: Record<string, string>,
  profileId: string,
): Promise<void> {
  await saveConnection(db, profileId, provider, credentials);

  logger.info("Credentials connection saved", { provider, authMode, profileId });
}
