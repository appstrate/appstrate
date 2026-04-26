// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";

// ─────────────────────────────────────────────
// Package type configuration
// ─────────────────────────────────────────────

export interface PackageTypeConfig {
  type: PackageType;
  storageFolder: "agents" | "skills" | "tools" | "providers";
  label: string;
}

export const CONFIG_BY_TYPE: Record<PackageType, PackageTypeConfig> = {
  agent: { type: "agent", storageFolder: "agents", label: "Agents" },
  skill: { type: "skill", storageFolder: "skills", label: "Skills" },
  tool: { type: "tool", storageFolder: "tools", label: "Tools" },
  provider: { type: "provider", storageFolder: "providers", label: "Providers" },
};

/** Resolve the S3 storage folder for a package type (e.g. "tool" → "tools"). */
export function storageFolderForType(type: PackageType): PackageTypeConfig["storageFolder"] {
  return CONFIG_BY_TYPE[type].storageFolder;
}

// ─────────────────────────────────────────────
// Package items storage bucket
// ─────────────────────────────────────────────

export const PACKAGE_ITEMS_BUCKET = "library-packages";
