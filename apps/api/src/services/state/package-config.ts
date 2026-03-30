import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageConfigs } from "@appstrate/db/schema";
import { asRecord } from "../../lib/safe-json.ts";

// --- Package Config (per-org) ---

export async function getPackageConfig(
  orgId: string,
  packageId: string,
): Promise<{
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
  orgProfileId: string | null;
}> {
  const [row] = await db
    .select({
      config: packageConfigs.config,
      modelId: packageConfigs.modelId,
      proxyId: packageConfigs.proxyId,
      orgProfileId: packageConfigs.orgProfileId,
    })
    .from(packageConfigs)
    .where(and(eq(packageConfigs.orgId, orgId), eq(packageConfigs.packageId, packageId)))
    .limit(1);
  return {
    config: asRecord(row?.config),
    modelId: row?.modelId ?? null,
    proxyId: row?.proxyId ?? null,
    orgProfileId: row?.orgProfileId ?? null,
  };
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

export async function setFlowOverride(
  orgId: string,
  packageId: string,
  field: "modelId" | "proxyId" | "orgProfileId",
  value: string | null,
): Promise<void> {
  await db
    .insert(packageConfigs)
    .values({ orgId, packageId, config: {}, [field]: value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [packageConfigs.orgId, packageConfigs.packageId],
      set: { [field]: value, updatedAt: new Date() },
    });
}
