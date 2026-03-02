import * as storage from "@appstrate/db/storage";
import {
  getBuiltInSkills,
  getBuiltInExtensions,
  isBuiltInSkill,
  isBuiltInExtension,
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
  label: string;
}

export const SKILL_CONFIG: LibraryTypeConfig = {
  type: "skill",
  storageFolder: "skills",
  getBuiltIns: getBuiltInSkills,
  isBuiltIn: isBuiltInSkill,
  label: "Skills",
};

export const EXTENSION_CONFIG: LibraryTypeConfig = {
  type: "extension",
  storageFolder: "extensions",
  getBuiltIns: getBuiltInExtensions,
  isBuiltIn: isBuiltInExtension,
  label: "Extensions",
};

// ─────────────────────────────────────────────
// Library storage bucket
// ─────────────────────────────────────────────

export const LIBRARY_BUCKET = "library-packages";

/** Ensure the library-packages Storage bucket exists. Call once at boot. */
export const ensureLibraryBucket = () => storage.ensureBucket(LIBRARY_BUCKET);
