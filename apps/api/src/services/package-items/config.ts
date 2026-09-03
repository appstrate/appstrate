// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import {
  checkSkillMarkdown,
  decodeSkillMarkdown,
  type CompanionFileViolation,
} from "@appstrate/afps-shared/companion-files";
import { PACKAGE_CONTENT_ENTRY } from "@appstrate/core/package-files";
import { validationFailed } from "../../lib/errors.ts";

// ─────────────────────────────────────────────
// Package type configuration
// ─────────────────────────────────────────────

export interface PackageTypeConfig {
  type: PackageType;
  storageFolder: "agents" | "skills" | "integrations" | "mcp-servers";
  label: string;
  /**
   * Producer-side check for this type's authored content, run by every path
   * that WRITES it. Returns the first violation, or `null`.
   *
   * Distinct from `checkCompanionFiles`, which also runs on the loader side
   * over already-published, immutable bundles and therefore stays lenient.
   */
  validateContent?: (content: string) => CompanionFileViolation | null;
}

export const CONFIG_BY_TYPE: Record<PackageType, PackageTypeConfig> = {
  agent: { type: "agent", storageFolder: "agents", label: "Agents" },
  skill: {
    type: "skill",
    storageFolder: "skills",
    label: "Skills",
    validateContent: checkSkillMarkdown,
  },
  // Phase 1.0 — INTEGRATIONS_PROPOSAL §4.1.
  integration: { type: "integration", storageFolder: "integrations", label: "Integrations" },
  // AFPS §3.4 — standalone MCP Bundle (MCPB) packages referenced by an
  // integration's `source.kind: "local"`.
  "mcp-server": { type: "mcp-server", storageFolder: "mcp-servers", label: "MCP Servers" },
};

/**
 * Run a type's {@link PackageTypeConfig.validateContent} over authored content
 * and answer a 400 carrying the violation reason as the machine-readable
 * `code`, so a client can tell "no description" from "bad name".
 */
export function assertContentConforms(
  type: PackageType,
  content: string,
  field: "content" | "file",
  prefix = "",
): void {
  const violation = CONFIG_BY_TYPE[type].validateContent?.(content);
  if (!violation) return;
  throw validationFailed([
    {
      field,
      code: violation.reason.toLowerCase(),
      title: "Invalid Content",
      message: `${prefix}${violation.message}`,
    },
  ]);
}

/**
 * Same gate, applied to the content entry of an archive the caller is about to
 * write. Decoded with `decodeSkillMarkdown`, which keeps a leading BOM the
 * default `TextDecoder` would eat — the gate has to see the byte it rejects.
 */
export function assertArchiveContentConforms(
  type: PackageType,
  files: Record<string, Uint8Array> | Map<string, Uint8Array>,
  field: "content" | "file",
  prefix = "",
): void {
  if (!CONFIG_BY_TYPE[type].validateContent) return;
  const path = PACKAGE_CONTENT_ENTRY[type]?.path;
  const bytes =
    path === undefined ? undefined : files instanceof Map ? files.get(path) : files[path];
  assertContentConforms(type, bytes ? decodeSkillMarkdown(bytes) : "", field, prefix);
}

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
