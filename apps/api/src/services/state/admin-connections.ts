import { eq, and } from "drizzle-orm";
import { db } from "../../lib/db.ts";
import { packageAdminConnections } from "@appstrate/db/schema";

// --- Admin Connections (per-org) ---

export async function getAdminConnections(
  orgId: string,
  packageId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      serviceId: packageAdminConnections.serviceId,
      profileId: packageAdminConnections.profileId,
    })
    .from(packageAdminConnections)
    .where(
      and(
        eq(packageAdminConnections.orgId, orgId),
        eq(packageAdminConnections.packageId, packageId),
      ),
    );
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.profileId) {
      result[row.serviceId] = row.profileId;
    }
  }
  return result;
}

export async function bindAdminConnection(
  orgId: string,
  packageId: string,
  serviceId: string,
  profileId: string,
): Promise<void> {
  await db
    .insert(packageAdminConnections)
    .values({
      orgId,
      packageId,
      serviceId,
      profileId,
      connectedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [packageAdminConnections.packageId, packageAdminConnections.serviceId],
      set: {
        orgId,
        profileId,
        connectedAt: new Date(),
      },
    });
}

export async function unbindAdminConnection(
  orgId: string,
  packageId: string,
  serviceId: string,
): Promise<void> {
  await db
    .delete(packageAdminConnections)
    .where(
      and(
        eq(packageAdminConnections.orgId, orgId),
        eq(packageAdminConnections.packageId, packageId),
        eq(packageAdminConnections.serviceId, serviceId),
      ),
    );
}
