import * as storage from "@appstrate/db/storage";
import {
  getBuiltInSkills,
  getBuiltInExtensions,
  isBuiltInSkill,
  isBuiltInExtension,
  resolveBuiltInSkill,
  resolveBuiltInExtension,
} from "../builtin-library.ts";

// ─────────────────────────────────────────────
// Library type configuration
// ─────────────────────────────────────────────

interface BuiltInItem {
  id: string;
  name: string;
  description: string;
  content: string;
}

export interface LibraryTypeConfig {
  type: "skill" | "extension";
  storageFolder: "skills" | "extensions";
  getBuiltIns: () => ReadonlyMap<string, BuiltInItem>;
  isBuiltIn: (id: string) => boolean;
  resolveBuiltIn: (id: string) => BuiltInItem | undefined;
  label: string;
}

export const SKILL_CONFIG: LibraryTypeConfig = {
  type: "skill",
  storageFolder: "skills",
  getBuiltIns: getBuiltInSkills,
  isBuiltIn: isBuiltInSkill,
  resolveBuiltIn: resolveBuiltInSkill,
  label: "Skills",
};

export const EXTENSION_CONFIG: LibraryTypeConfig = {
  type: "extension",
  storageFolder: "extensions",
  getBuiltIns: getBuiltInExtensions,
  isBuiltIn: isBuiltInExtension,
  resolveBuiltIn: resolveBuiltInExtension,
  label: "Extensions",
};

// ─────────────────────────────────────────────
// Library storage bucket
// ─────────────────────────────────────────────

export const LIBRARY_BUCKET = "library-packages";

/** Ensure the library-packages Storage bucket exists. Call once at boot. */
export const ensureLibraryBucket = () => storage.ensureBucket(LIBRARY_BUCKET);
