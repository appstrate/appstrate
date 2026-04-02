// SPDX-License-Identifier: Apache-2.0

import type { packageTypeEnum } from "@appstrate/db/schema";

// ─────────────────────────────────────────────
// Package type configuration
// ─────────────────────────────────────────────

export type PackageType = (typeof packageTypeEnum.enumValues)[number];

export interface PackageTypeConfig {
  type: PackageType;
  storageFolder: "agents" | "skills" | "tools" | "providers";
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

export const AGENT_CONFIG: PackageTypeConfig = {
  type: "agent",
  storageFolder: "agents",
  label: "Agents",
};

export const PROVIDER_CONFIG: PackageTypeConfig = {
  type: "provider",
  storageFolder: "providers",
  label: "Providers",
};

// ─────────────────────────────────────────────
// Type → config lookup
// ─────────────────────────────────────────────

const ALL_CONFIGS: PackageTypeConfig[] = [AGENT_CONFIG, SKILL_CONFIG, TOOL_CONFIG, PROVIDER_CONFIG];

const CONFIG_BY_TYPE = Object.fromEntries(ALL_CONFIGS.map((c) => [c.type, c])) as Record<
  PackageType,
  PackageTypeConfig
>;

/** Resolve the S3 storage folder for a package type (e.g. "tool" → "tools"). */
export function storageFolderForType(type: PackageType): PackageTypeConfig["storageFolder"] {
  return CONFIG_BY_TYPE[type].storageFolder;
}

// ─────────────────────────────────────────────
// Package items storage bucket
// ─────────────────────────────────────────────

export const PACKAGE_ITEMS_BUCKET = "library-packages";
