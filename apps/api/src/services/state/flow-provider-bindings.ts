import { eq, and } from "drizzle-orm";
import { db } from "../../lib/db.ts";
import { flowProviderBindings } from "@appstrate/db/schema";

// --- Flow Provider Bindings (per-org) ---

export async function getFlowProviderBindings(
  orgId: string,
  packageId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      providerId: flowProviderBindings.providerId,
      profileId: flowProviderBindings.profileId,
    })
    .from(flowProviderBindings)
    .where(
      and(eq(flowProviderBindings.orgId, orgId), eq(flowProviderBindings.packageId, packageId)),
    );
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.profileId) {
      result[row.providerId] = row.profileId;
    }
  }
  return result;
}

export async function bindFlowProvider(
  orgId: string,
  packageId: string,
  providerId: string,
  profileId: string,
): Promise<void> {
  await db
    .insert(flowProviderBindings)
    .values({
      orgId,
      packageId,
      providerId,
      profileId,
      connectedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [flowProviderBindings.packageId, flowProviderBindings.providerId],
      set: {
        orgId,
        profileId,
        connectedAt: new Date(),
      },
    });
}

export async function unbindFlowProvider(
  orgId: string,
  packageId: string,
  providerId: string,
): Promise<void> {
  await db
    .delete(flowProviderBindings)
    .where(
      and(
        eq(flowProviderBindings.orgId, orgId),
        eq(flowProviderBindings.packageId, packageId),
        eq(flowProviderBindings.providerId, providerId),
      ),
    );
}
