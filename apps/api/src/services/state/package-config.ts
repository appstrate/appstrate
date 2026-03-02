import { eq, and } from "drizzle-orm";
import { db } from "../../lib/db.ts";
import { packageConfigs } from "@appstrate/db/schema";

// --- Package Config (per-org) ---

export async function getPackageConfig(
  orgId: string,
  packageId: string,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ config: packageConfigs.config })
    .from(packageConfigs)
    .where(and(eq(packageConfigs.orgId, orgId), eq(packageConfigs.packageId, packageId)))
    .limit(1);
  return (row?.config ?? {}) as Record<string, unknown>;
}

export async function setPackageConfig(
  orgId: string,
  packageId: string,
  config: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(packageConfigs)
    .values({
      orgId,
      packageId,
      config,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [packageConfigs.orgId, packageConfigs.packageId],
      set: {
        config,
        updatedAt: new Date(),
      },
    });
}
