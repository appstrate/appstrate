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
      providerId: packageAdminConnections.providerId,
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
      result[row.providerId] = row.profileId;
    }
  }
  return result;
}

export async function bindAdminConnection(
  orgId: string,
  packageId: string,
  providerId: string,
  profileId: string,
): Promise<void> {
  await db
    .insert(packageAdminConnections)
    .values({
      orgId,
      packageId,
      providerId,
      profileId,
      connectedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [packageAdminConnections.packageId, packageAdminConnections.providerId],
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
  providerId: string,
): Promise<void> {
  await db
    .delete(packageAdminConnections)
    .where(
      and(
        eq(packageAdminConnections.orgId, orgId),
        eq(packageAdminConnections.packageId, packageId),
        eq(packageAdminConnections.providerId, providerId),
      ),
    );
}
