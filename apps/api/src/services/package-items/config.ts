import type { packageTypeEnum } from "@appstrate/db/schema";
import * as storage from "@appstrate/db/storage";

// ─────────────────────────────────────────────
// Package type configuration
// ─────────────────────────────────────────────

export type PackageType = (typeof packageTypeEnum.enumValues)[number];

export interface PackageTypeConfig {
  type: PackageType;
  storageFolder: "flows" | "skills" | "tools" | "providers";
  label: string;
}

export const SKILL_CONFIG: PackageTypeConfig = {
  type: "skill",
  storageFolder: "skills",
  label: "Skills",
};

export const TOOL_CONFIG: PackageTypeConfig = {
  type: "tool",
  storageFolder: "tools",
  label: "Tools",
};

export const FLOW_CONFIG: PackageTypeConfig = {
  type: "flow",
  storageFolder: "flows",
  label: "Flows",
};

export const PROVIDER_CONFIG: PackageTypeConfig = {
  type: "provider",
  storageFolder: "providers",
  label: "Providers",
};

// ─────────────────────────────────────────────
// Package items storage bucket
// ─────────────────────────────────────────────

export const PACKAGE_ITEMS_BUCKET = "library-packages";

/** Ensure the package-items Storage bucket exists. Call once at boot. */
export const ensurePackageItemsBucket = () => storage.ensureBucket(PACKAGE_ITEMS_BUCKET);
