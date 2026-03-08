import { db } from "../lib/db.ts";
import { providerCredentials } from "@appstrate/db/schema";
import { getSystemPackagesByType } from "./builtin-packages.ts";
import { logger } from "../lib/logger.ts";

/**
 * Provision system providers (providerCredentials) for a new org.
 * The packages row is global (PK on id), so no per-org insert is needed.
 */
export async function provisionSystemProvidersForOrg(orgId: string): Promise<void> {
  const providers = getSystemPackagesByType("provider");
  if (providers.length === 0) return;

  for (const entry of providers) {
    await db
      .insert(providerCredentials)
      .values({ providerId: entry.packageId, orgId })
      .onConflictDoNothing();
  }

  logger.info("System providers provisioned for org", {
    orgId,
    providers: providers.length,
  });
}
