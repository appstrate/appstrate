import * as storage from "@appstrate/db/storage";
import {
  getBuiltInSkills,
  getBuiltInExtensions,
  isBuiltInSkill,
  isBuiltInExtension,
  isSystemPackage,
  resolveBuiltInSkill,
  resolveBuiltInExtension,
} from "../builtin-packages.ts";
import { isBuiltInFlow } from "../flow-service.ts";

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
  type: "flow" | "skill" | "extension" | "provider";
  storageFolder: "flows" | "skills" | "extensions" | "providers";
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

/** Flows don't have the same built-in resolution (LoadedFlow ≠ BuiltInItem),
 *  but we need a PackageTypeConfig for CRUD uniformity. Built-in flows are
 *  handled at the route level (requireFlow middleware), so these are no-ops. */
const EMPTY_MAP = new Map<string, BuiltInItem>();

export const FLOW_CONFIG: PackageTypeConfig = {
  type: "flow",
  storageFolder: "flows",
  getBuiltIns: () => EMPTY_MAP,
  isBuiltIn: isBuiltInFlow,
  resolveBuiltIn: () => undefined,
  label: "Flows",
};

export const PROVIDER_CONFIG: PackageTypeConfig = {
  type: "provider",
  storageFolder: "providers",
  getBuiltIns: () => EMPTY_MAP,
  isBuiltIn: isSystemPackage,
  resolveBuiltIn: () => undefined,
  label: "Providers",
};

// ─────────────────────────────────────────────
// Package items storage bucket
// ─────────────────────────────────────────────

export const PACKAGE_ITEMS_BUCKET = "library-packages";

/** Ensure the package-items Storage bucket exists. Call once at boot. */
export const ensurePackageItemsBucket = () => storage.ensureBucket(PACKAGE_ITEMS_BUCKET);
