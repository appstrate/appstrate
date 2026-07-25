// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";

// ─────────────────────────────────────────────
// Package type configuration
// ─────────────────────────────────────────────

export interface PackageTypeConfig {
  type: PackageType;
  storageFolder: "agents" | "skills" | "integrations" | "mcp-servers";
  label: string;
}

export const CONFIG_BY_TYPE: Record<PackageType, PackageTypeConfig> = {
  agent: { type: "agent", storageFolder: "agents", label: "Agents" },
  skill: { type: "skill", storageFolder: "skills", label: "Skills" },
  // Phase 1.0 — INTEGRATIONS_PROPOSAL §4.1.
  integration: { type: "integration", storageFolder: "integrations", label: "Integrations" },
  // AFPS §3.4 — standalone MCP Bundle (MCPB) packages referenced by an
  // integration's `source.kind: "local"`.
  "mcp-server": { type: "mcp-server", storageFolder: "mcp-servers", label: "MCP Servers" },
};

/** Resolve the S3 storage folder for a package type (e.g. "skill" → "skills"). */
export function storageFolderForType(type: PackageType): PackageTypeConfig["storageFolder"] {
  return CONFIG_BY_TYPE[type].storageFolder;
}

// ─────────────────────────────────────────────
// Package items storage bucket + key layout
// ─────────────────────────────────────────────

export const PACKAGE_ITEMS_BUCKET = "library-packages";

/** Global namespace for system packages in the bucket (they have no org). */
export const SYSTEM_STORAGE_NAMESPACE = "_system";

/**
 * The bucket namespace a package's files live under, derived from the row's
 * `orgId`: a real org id, or the global `_system/` namespace when `orgId` is
 * null (system packages, synced from `system-packages/` at boot).
 *
 * Callers that reconcile the bucket against the DB MUST go through this so a
 * system object is never mistaken for an orphan, and an org-scoped purge never
 * reaches into `_system/`.
 */
export function packageItemOwnerNamespace(orgId: string | null): string {
  return orgId ?? SYSTEM_STORAGE_NAMESPACE;
}

/**
 * In-bucket key of a package item's ZIP:
 * `{orgId|_system}/{storageFolder}/{itemId}.afps`.
 *
 * `itemId` is the `@scope/name` package id (so the key legitimately contains a
 * `/`). One builder so the upload, the deletion outbox and the orphan scanner
 * cannot drift — a job pointing at a key nobody wrote deletes nothing.
 */
export function packageItemKey(
  storageFolder: PackageTypeConfig["storageFolder"],
  ownerNamespace: string,
  itemId: string,
): string {
  return `${ownerNamespace}/${storageFolder}/${itemId}.afps`;
}
