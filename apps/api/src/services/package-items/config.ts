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
  /**
   * How this type names ONE of its packages in a message a user reads ("Skill
   * '@acme/x' not found", "Skill was modified concurrently").
   *
   * Stated per entry, never derived from a plural by dropping a letter: a label
   * whose singular is not the plural minus one character breaks that silently,
   * in error text, where nothing type-checks it.
   */
  labelSingular: string;
  /** Producer-side check for this type's authored content, run by every path that WRITES it. */
  validateContent?: (content: string) => CompanionFileViolation | null;
  /**
   * Whether `PATCH /api/packages/{scope}/{name}/files` may write, delete and
   * move entries in this type's draft tree; a `PATCH` on a type that says `false`
   * is refused with `400 package_type_not_editable`.
   *
   * `agent` and `skill` say `true`: their packages are an authored directory —
   * a prompt or a `SKILL.md` plus whatever scripts, references and assets sit
   * beside it — and the editor is the tool that writes it. `integration` and
   * `mcp-server` say `false`: their packages carry an executable bundle whose
   * invariants `parsePackageZip` enforces at import and publish, and opening
   * arbitrary per-file writes on them is a decision of its own rather than a
   * consequence of this one.
   */
  draftFilesWritable: boolean;
  /**
   * Whether `manifest.json` is a STORED file of this type's archive.
   *
   * For `agent` / `skill` it is not: the row owns the manifest, the file
   * explorer's overlay materializes it (`applyDraftOverlay`), publish rebuilds
   * it from the row and the draft-run catalog synthesizes it — so a second copy
   * in the ZIP can only go stale. Every write of such a package's tree drops it
   * before uploading.
   *
   * For `integration` / `mcp-server` it IS the editor's storage sink
   * (`storageFileName`, `routes/packages.ts`) and the bundle's portable
   * manifest, so it is stored like any other file.
   *
   * A fact of the TYPE, exactly like `storageFolder` is, so it is declared
   * here rather than derived per request at a call site: every writer of one
   * package's tree must agree about whether the manifest belongs in it, and an
   * option each writer computes for itself is an agreement nothing enforces.
   */
  manifestIsStoredFile: boolean;
}

export const CONFIG_BY_TYPE: Record<PackageType, PackageTypeConfig> = {
  agent: {
    type: "agent",
    storageFolder: "agents",
    labelSingular: "Agent",
    draftFilesWritable: true,
    manifestIsStoredFile: false,
  },
  skill: {
    type: "skill",
    storageFolder: "skills",
    labelSingular: "Skill",
    validateContent: checkSkillMarkdown,
    draftFilesWritable: true,
    manifestIsStoredFile: false,
  },
  // Phase 1.0 — INTEGRATIONS_PROPOSAL §4.1.
  integration: {
    type: "integration",
    storageFolder: "integrations",
    labelSingular: "Integration",
    draftFilesWritable: false,
    manifestIsStoredFile: true,
  },
  // AFPS §3.4 — standalone MCP Bundle (MCPB) packages referenced by an
  // integration's `source.kind: "local"`.
  "mcp-server": {
    type: "mcp-server",
    storageFolder: "mcp-servers",
    labelSingular: "MCP Server",
    draftFilesWritable: false,
    manifestIsStoredFile: true,
  },
};

/** 400 with the violation reason as the machine-readable `code`. */
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

/** The same gate over an archive's content entry, BOM preserved. */
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
