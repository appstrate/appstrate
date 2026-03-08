import * as storage from "@appstrate/db/storage";

// ─────────────────────────────────────────────
// Package type configuration
// ─────────────────────────────────────────────

export interface PackageTypeConfig {
  type: "flow" | "skill" | "extension" | "provider";
  storageFolder: "flows" | "skills" | "extensions" | "providers";
  label: string;
}

export const SKILL_CONFIG: PackageTypeConfig = {
  type: "skill",
  storageFolder: "skills",
  label: "Skills",
};

export const EXTENSION_CONFIG: PackageTypeConfig = {
  type: "extension",
  storageFolder: "extensions",
  label: "Extensions",
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
