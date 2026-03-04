import * as storage from "@appstrate/db/storage";
import {
  getBuiltInSkills,
  getBuiltInExtensions,
  isBuiltInSkill,
  isBuiltInExtension,
  resolveBuiltInSkill,
  resolveBuiltInExtension,
} from "../builtin-packages.ts";

// ─────────────────────────────────────────────
// Package type configuration
// ─────────────────────────────────────────────

interface BuiltInItem {
  id: string;
  name: string;
  description: string;
  content: string;
}

export interface PackageTypeConfig {
  type: "skill" | "extension";
  storageFolder: "skills" | "extensions";
  getBuiltIns: () => ReadonlyMap<string, BuiltInItem>;
  isBuiltIn: (id: string) => boolean;
  resolveBuiltIn: (id: string) => BuiltInItem | undefined;
  label: string;
}

export const SKILL_CONFIG: PackageTypeConfig = {
  type: "skill",
  storageFolder: "skills",
  getBuiltIns: getBuiltInSkills,
  isBuiltIn: isBuiltInSkill,
  resolveBuiltIn: resolveBuiltInSkill,
  label: "Skills",
};

export const EXTENSION_CONFIG: PackageTypeConfig = {
  type: "extension",
  storageFolder: "extensions",
  getBuiltIns: getBuiltInExtensions,
  isBuiltIn: isBuiltInExtension,
  resolveBuiltIn: resolveBuiltInExtension,
  label: "Extensions",
};

// ─────────────────────────────────────────────
// Package items storage bucket
// ─────────────────────────────────────────────

export const PACKAGE_ITEMS_BUCKET = "library-packages";

/** Ensure the package-items Storage bucket exists. Call once at boot. */
export const ensurePackageItemsBucket = () => storage.ensureBucket(PACKAGE_ITEMS_BUCKET);
