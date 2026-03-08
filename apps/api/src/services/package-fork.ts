import { parseScopedName, isOwnedByOrg } from "@appstrate/core/naming";
import type { Manifest } from "@appstrate/core/validation";
import {
  getOrgItem,
  getPackageById,
  createOrgItem,
  syncFlowDepsJunctionTable,
  uploadPackageFiles,
  type PackageTypeConfig,
  FLOW_CONFIG,
  SKILL_CONFIG,
  EXTENSION_CONFIG,
  PROVIDER_CONFIG,
} from "./package-items.ts";
import { extractDepsFromManifest } from "../lib/manifest-utils.ts";
import { downloadPackageFiles } from "./package-items/storage.ts";

const TYPE_TO_CONFIG: Record<string, PackageTypeConfig> = {
  flow: FLOW_CONFIG,
  skill: SKILL_CONFIG,
  extension: EXTENSION_CONFIG,
  provider: PROVIDER_CONFIG,
};

export interface ForkResult {
  packageId: string;
  type: string;
  forkedFrom: string;
}

export type ForkError =
  | { code: "ALREADY_OWNED" }
  | { code: "NOT_FOUND" }
  | { code: "NAME_COLLISION"; existingId: string }
  | { code: "UNKNOWN_TYPE"; type: string };

export async function forkPackage(
  orgId: string,
  orgSlug: string,
  sourcePackageId: string,
  userId?: string,
  customName?: string,
): Promise<ForkResult | ForkError> {
  if (isOwnedByOrg(sourcePackageId, orgSlug)) {
    return { code: "ALREADY_OWNED" };
  }

  const parsed = parseScopedName(sourcePackageId);
  if (!parsed) return { code: "NOT_FOUND" };

  const cfg = TYPE_TO_CONFIG[await getPackageType(orgId, sourcePackageId)];
  if (!cfg) {
    // Try to find the package to get its type
    const raw = await getPackageById(sourcePackageId);
    if (!raw) return { code: "NOT_FOUND" };
    const typeCfg = TYPE_TO_CONFIG[raw.type];
    if (!typeCfg) return { code: "UNKNOWN_TYPE", type: raw.type };
    return forkWithConfig(
      orgId,
      orgSlug,
      sourcePackageId,
      customName ?? parsed.name,
      typeCfg,
      userId,
    );
  }

  return forkWithConfig(orgId, orgSlug, sourcePackageId, customName ?? parsed.name, cfg, userId);
}

async function getPackageType(orgId: string, packageId: string): Promise<string> {
  // Try each config type to find the package in the org context
  for (const [type, cfg] of Object.entries(TYPE_TO_CONFIG)) {
    const item = await getOrgItem(orgId, packageId, cfg);
    if (item) return type;
  }
  return "";
}

async function forkWithConfig(
  orgId: string,
  orgSlug: string,
  sourcePackageId: string,
  sourceName: string,
  cfg: PackageTypeConfig,
  userId?: string,
): Promise<ForkResult | ForkError> {
  // Load source package
  const source = await getOrgItem(orgId, sourcePackageId, cfg);
  if (!source) return { code: "NOT_FOUND" };

  // Build target packageId
  const targetId = `@${orgSlug}/${sourceName}`;

  // Check for collision
  const existing = await getPackageById(targetId);
  if (existing) return { code: "NAME_COLLISION", existingId: targetId };

  // Update manifest.name to new packageId
  const updatedManifest = { ...(source.manifest ?? {}) };
  updatedManifest.name = targetId;

  // Create the fork
  const newPkg = await createOrgItem(
    orgId,
    orgSlug,
    {
      id: sourceName,
      name: (source.name as string) ?? undefined,
      description: (source.description as string) ?? undefined,
      content: source.content ?? "",
      createdBy: userId,
    },
    cfg,
    updatedManifest,
    sourcePackageId,
  );

  // Copy storage files if they exist
  const files = await downloadPackageFiles(cfg.storageFolder, orgId, sourcePackageId);
  if (files && Object.keys(files).length > 0) {
    await uploadPackageFiles(cfg.storageFolder, orgId, newPkg.id, files);
  }

  // Sync flow dependencies if it's a flow
  if (cfg.type === "flow") {
    const manifest = updatedManifest as Partial<Manifest>;
    const { skillIds, extensionIds, providerIds } = extractDepsFromManifest(manifest);
    await syncFlowDepsJunctionTable(newPkg.id, orgId, skillIds, extensionIds, providerIds);
  }

  return {
    packageId: newPkg.id,
    type: cfg.type,
    forkedFrom: sourcePackageId,
  };
}
