// SPDX-License-Identifier: Apache-2.0

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages } from "@appstrate/db/schema";
import { asRecord } from "../../lib/safe-json.ts";

// --- Package Config (per-app) ---

export async function getPackageConfig(
  applicationId: string,
  packageId: string,
): Promise<{
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
  orgProfileId: string | null;
}> {
  const [row] = await db
    .select({
      config: applicationPackages.config,
      modelId: applicationPackages.modelId,
      proxyId: applicationPackages.proxyId,
      orgProfileId: applicationPackages.orgProfileId,
    })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .limit(1);
  return {
    config: asRecord(row?.config),
    modelId: row?.modelId ?? null,
    proxyId: row?.proxyId ?? null,
    orgProfileId: row?.orgProfileId ?? null,
  };
}
