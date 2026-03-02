import { db } from "../../lib/db.ts";
import { getProvider } from "@appstrate/connect";
import { computeConfigHash, buildProviderSnapshot } from "../connection-profiles.ts";

/** Load provider definition and compute snapshot + configHash in one shot. */
export async function getProviderSnapshot(
  orgId: string,
  providerId: string,
): Promise<{
  snapshot: ReturnType<typeof buildProviderSnapshot>;
  configHash: string;
}> {
  const providerDef = await getProvider(db, orgId, providerId);
  if (!providerDef) throw new Error(`Provider '${providerId}' not found`);
  return {
    snapshot: buildProviderSnapshot(providerDef),
    configHash: computeConfigHash(providerDef),
  };
}

/** Map provider authMode to the uppercase label exposed in API responses. */
export function authModeLabel(authMode: string | undefined): string {
  switch (authMode) {
    case "api_key":
      return "API_KEY";
    case "proxy":
      return "PROXY";
    case "oauth1":
      return "OAUTH1";
    default:
      return "OAUTH2";
  }
}
