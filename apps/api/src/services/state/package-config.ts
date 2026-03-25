import { eq, and } from "drizzle-orm";
import { db } from "../../lib/db.ts";
import { packageConfigs } from "@appstrate/db/schema";
import { asRecord } from "../../lib/safe-json.ts";

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
  return asRecord(row?.config);
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

export async function getFlowOverrides(
  orgId: string,
  packageId: string,
): Promise<{ modelId: string | null; proxyId: string | null }> {
  const [row] = await db
    .select({ modelId: packageConfigs.modelId, proxyId: packageConfigs.proxyId })
    .from(packageConfigs)
    .where(and(eq(packageConfigs.orgId, orgId), eq(packageConfigs.packageId, packageId)))
    .limit(1);
  return { modelId: row?.modelId ?? null, proxyId: row?.proxyId ?? null };
}

export async function setFlowModelId(
  orgId: string,
  packageId: string,
  modelId: string | null,
): Promise<void> {
  await db
    .insert(packageConfigs)
    .values({ orgId, packageId, config: {}, modelId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [packageConfigs.orgId, packageConfigs.packageId],
      set: { modelId, updatedAt: new Date() },
    });
}

export async function setFlowProxyId(
  orgId: string,
  packageId: string,
  proxyId: string | null,
): Promise<void> {
  await db
    .insert(packageConfigs)
    .values({ orgId, packageId, config: {}, proxyId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [packageConfigs.orgId, packageConfigs.packageId],
      set: { proxyId, updatedAt: new Date() },
    });
}
