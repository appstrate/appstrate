// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { parsePackageZip, PackageZipError, zipArtifact } from "@appstrate/core/zip";
import { buildDownloadHeaders } from "@appstrate/core/integrity";
import { eq, and, inArray } from "drizzle-orm";
import { packages, profiles } from "@appstrate/db/schema";
import { db } from "@appstrate/db/client";
import { listResponse } from "../lib/list-response.ts";
import { postInstallPackage } from "../services/post-install-package.ts";
import { handleImportBundle } from "../services/bundle-import.ts";
import { parsePackageIdentity } from "@appstrate/afps-runtime/bundle";
import { installPackage, hasPackageAccess } from "../services/application-packages.ts";
import { resolveIntegrationActivations } from "../services/integration-connections.ts";
import { parseManifestBytesSafe } from "../lib/manifest-parser.ts";
import { getAllPackageIds } from "../services/package-catalog.ts";
import { isSystemPackage } from "../services/system-packages.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { getVersionForDownload, replaceVersionContent } from "../services/package-versions.ts";
import { downloadVersionZip } from "../services/package-storage.ts";
import { computeIntegrity } from "@appstrate/core/integrity";
import {
  getPackageById,
  listOrgItems,
  getOrgItem,
  createOrgItem,
  updateOrgItem,
  deleteOrgItem,
  PackageAlreadyExistsError,
} from "../services/package-items/crud.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { uploadPackageFiles, downloadPackageFiles } from "../services/package-items/storage.ts";
import { CONFIG_BY_TYPE, type PackageTypeConfig } from "../services/package-items/config.ts";
import { validateManifest, type PackageType } from "@appstrate/core/validation";
import { SLUG_REGEX } from "@appstrate/core/naming";
import { unzipAndNormalize } from "../services/package-storage.ts";
import { isValidVersion } from "@appstrate/core/semver";
import {
  getVersionDetail,
  getVersionCount,
  getMatchingDistTags,
  listPackageVersions,
  getVersionInfo,
  getLatestVersionCreatedAt,
  computeHasUnpublishedChanges,
  createVersionFromDraft,
  createVersionAndUpload,
  deletePackageVersion,
} from "../services/package-versions.ts";
import { agentDetailHandler, buildAgentDetailDto } from "./agent-detail-handler.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { requirePackageInOrg } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getRunningRunsForPackage } from "../services/state/runs.ts";
import { logger } from "../lib/logger.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { forkPackage } from "../services/package-fork.ts";
import { tryParseSkillOnlyZip } from "../services/skill-zip.ts";
import { fetchGithubDirectory, GithubImportError } from "../services/github-import.ts";
import { validateAgentIntegrationSelections } from "../services/integration-scope-validation.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";
import {
  collectConnectLoginWarnings,
  collectMetaWarnings,
} from "../services/integration-install-warnings.ts";
import {
  ApiError,
  invalidRequest,
  forbidden,
  notFound,
  conflict,
  internalError,
  validationFailed,
  type ValidationFieldError,
} from "../lib/errors.ts";
import { parsePathMessages } from "../lib/field-errors.ts";

function manifestErrorsToFieldErrors(errors: string[]): ValidationFieldError[] {
  return parsePathMessages(errors, {
    code: "invalid_manifest",
    title: "Invalid Manifest",
    fieldPrefix: "manifest.",
  });
}

/**
 * Phase 1 gate — after `validateManifest` accepts an agent manifest,
 * cross-check that any `integrations_configuration[id]` selection (§4.4)
 * is a subset of the referenced integration's catalog. Skips silently for
 * non-agent types, integrations with no configuration entry, and
 * integrations not visible to the org (the latter handled by run-time dep
 * validation).
 */
async function assertAgentIntegrationScopesValid(
  manifest: Record<string, unknown>,
  orgId: string,
): Promise<void> {
  const scopeErrors = await validateAgentIntegrationSelections({ manifest, orgId });
  if (scopeErrors.length > 0) {
    throw validationFailed(scopeErrors);
  }
}

// ═══════════════════════════════════════════════
// Shared helpers for package CRUD routes
// ═══════════════════════════════════════════════

export const githubImportSchema = z.object({
  url: z.url("Missing 'url' field"),
});

export const forkSchema = z.object({
  name: z.string().regex(SLUG_REGEX, "Name must match slug format").optional(),
});

/**
 * JSON-body create/update payloads for the manifest-driven package types
 * (agent). `manifest` is validated structurally here (must be an object) and
 * then deeply by `validateManifest`. Bodies with wrong-typed `content` /
 * `source_code` (e.g. `content: 1`) are now rejected as a 400 instead of
 * blowing up downstream as a 500.
 */
export const packageJsonCreateSchema = z.object({
  manifest: z.record(z.string(), z.unknown()),
  content: z.string().optional(),
  source_code: z.string().optional(),
});

export const packageJsonUpdateSchema = z.object({
  manifest: z.record(z.string(), z.unknown()).optional(),
  content: z.string().optional(),
  source_code: z.string().optional(),
  lock_version: z.number().optional(),
});

/** Enrich items with creator display names (batch lookup). */
async function enrichWithCreatorNames<T extends { created_by?: string | null }>(
  items: T[],
): Promise<(T & { created_by_name?: string })[]> {
  const userIds = [...new Set(items.map((i) => i.created_by).filter(Boolean))] as string[];
  if (userIds.length === 0) return items;

  const rows = await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .where(inArray(profiles.id, userIds));

  const nameMap = new Map(rows.map((p) => [p.id, p.displayName]));

  return items.map((item) => ({
    ...item,
    created_by_name: item.created_by ? (nameMap.get(item.created_by) ?? undefined) : undefined,
  }));
}

// --- Shared ZIP upload parsing ---

interface ParsedUpload {
  id: string;
  name?: string;
  description?: string;
  content: string;
  normalizedFiles?: Record<string, Uint8Array>;
  /** Full parsed manifest.json from the ZIP — stored as-is (like the registry). */
  manifest?: Record<string, unknown>;
  /** User-specified version from JSON body (propagated to manifest default). */
  version?: string;
}

/** JSON body shape for the non-multipart package upload branch. */
const jsonUploadSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  manifest: z.record(z.string(), z.unknown()).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
});

/**
 * Parse a package item upload from a Hono context (multipart ZIP or JSON body).
 * Throws ApiError on validation errors.
 */
async function parsePackageUpload(
  c: Context<AppEnv>,
  opts: {
    /** Required file inside the ZIP (e.g. "SKILL.md") — null to skip check */
    requiredFile: string | null;
    /** Find the content file by extension (e.g. ".ts") — null to use requiredFile */
    contentFileExt: string | null;
  },
): Promise<ParsedUpload> {
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      throw invalidRequest("File is required", "file");
    }

    if (!file.name.endsWith(".afps") && !file.name.endsWith(".zip")) {
      throw invalidRequest("Only .afps and .zip files are accepted", "file");
    }

    const id = file.name.replace(/\.(afps|zip)$/i, "");
    if (!SLUG_REGEX.test(id)) {
      throw invalidRequest("Invalid file name (kebab-case slug required)", "file");
    }

    let normalizedFiles: Record<string, Uint8Array>;
    try {
      normalizedFiles = unzipAndNormalize(Buffer.from(await file.arrayBuffer()));
    } catch {
      throw invalidRequest("Invalid ZIP file", "file");
    }

    // Find the content file
    let contentFile: string | undefined;
    if (opts.requiredFile) {
      if (!normalizedFiles[opts.requiredFile]) {
        throw invalidRequest(`ZIP must contain ${opts.requiredFile}`, "file");
      }
      contentFile = opts.requiredFile;
    }
    if (opts.contentFileExt) {
      contentFile = Object.keys(normalizedFiles).find((p) => p.endsWith(opts.contentFileExt!));
      if (!contentFile) {
        throw invalidRequest(`ZIP must contain a ${opts.contentFileExt} file`, "file");
      }
    }

    const content = new TextDecoder().decode(normalizedFiles[contentFile!]!);

    let name: string | undefined;
    let description: string | undefined;

    // Parse manifest.json from ZIP if present — store as-is (like the registry)
    let manifest: Record<string, unknown> | undefined;
    const manifestBytes = normalizedFiles["manifest.json"];
    if (manifestBytes) {
      manifest = parseManifestBytesSafe(manifestBytes);
      if (manifest) {
        // Extract display fields as fallbacks (not for manifest storage)
        if (!name && typeof manifest.display_name === "string") name = manifest.display_name;
        if (!description && typeof manifest.description === "string")
          description = manifest.description;
      }
    }

    // Allow overriding name/description from form fields
    const formName = formData.get("name") as string | null;
    const formDesc = formData.get("description") as string | null;
    if (formName) name = formName;
    if (formDesc) description = formDesc;

    return { id, name, description, content, normalizedFiles, manifest };
  }

  // JSON body
  const body = await readJsonBody(c, jsonUploadSchema);

  if (!SLUG_REGEX.test(body.id)) {
    throw invalidRequest("Invalid id (kebab-case slug required)", "id");
  }

  const { name, description } = body;

  // Synthesize normalizedFiles so the ZIP is uploaded to storage (same as multipart path)
  const encoded = new TextEncoder().encode(body.content);
  const fileName =
    opts.requiredFile ?? (opts.contentFileExt ? `${body.id}${opts.contentFileExt}` : "content");
  const normalizedFiles: Record<string, Uint8Array> = { [fileName]: encoded };

  return {
    id: body.id,
    name,
    description,
    content: body.content,
    normalizedFiles,
    manifest: body.manifest,
    version: body.version,
  };
}

/** Create a version snapshot from files + manifest (non-fatal on error).
 *  All package types are zipped as-is. */
async function createVersionSafe(params: {
  packageId: string;
  orgId: string;
  userId: string;
  manifest: Record<string, unknown>;
  normalizedFiles: Record<string, Uint8Array>;
}): Promise<void> {
  const version = params.manifest.version as string | undefined;
  if (!version || !isValidVersion(version)) {
    logger.warn("Skipping version creation: missing or invalid version in manifest", {
      packageId: params.packageId,
    });
    return;
  }
  try {
    const manifestToStore = params.manifest;
    const entries: Record<string, Uint8Array> = { ...params.normalizedFiles };
    entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(params.manifest, null, 2));
    const zipBuffer = Buffer.from(zipArtifact(entries, 6));

    await createVersionAndUpload({
      packageId: params.packageId,
      version,
      createdBy: params.userId,
      zipBuffer,
      manifest: manifestToStore,
    });
  } catch (error) {
    logger.warn("Version upload failed (non-fatal)", { packageId: params.packageId, error });
  }
}

// --- Route configuration per package type ---

interface PackageRouteConfig {
  cfg: PackageTypeConfig;
  /** URL path segment used for routing (e.g. "skills", "integrations"). */
  path: string;
  parseOpts: {
    requiredFile: string | null;
    contentFileExt: string | null;
  };
  validateContent?: (content: string) => { valid: boolean; errors: string[]; warnings: string[] };
  /** Validates the secondary source file (e.g. .ts for tools). */
  validateSource?: (source: string) => { valid: boolean; errors: string[]; warnings: string[] };
  storageFileName: (id: string) => string;
  /** Secondary source file name (e.g. {name}.ts for tools). */
  sourceFileName?: (id: string) => string;
  /** Hook called after a new package is created. */
  afterCreate?: (params: {
    packageId: string;
    orgId: string;
    manifest: Record<string, unknown>;
    applicationId?: string;
  }) => Promise<void>;
  /** Hook called after a package is updated. */
  afterUpdate?: (params: {
    packageId: string;
    orgId: string;
    manifest: Record<string, unknown>;
  }) => Promise<void>;
  /** If true, version create/restore require no running runs (agents). */
  requireMutableForVersionOps?: boolean;
  /** If true, this type uses JSON body for create (not ZIP upload parsing). */
  jsonBodyCreate?: boolean;
  /** If true, content is required when creating via JSON body. */
  requireContent?: boolean;
  /** Custom GET detail handler, replaces makeGetHandler when provided. */
  getHandler?: (c: Context<AppEnv>) => Promise<Response>;
  /**
   * Custom builder for the package detail DTO returned by mutating endpoints
   * (create / update / fork). When provided it overrides the generic
   * `buildPackageDetailDto` so the type's own GET serializer is reused
   * (agents return the richer Agent detail via `buildAgentDetailDto`).
   * Returns `null` when the package cannot be resolved.
   */
  detailDto?: (
    c: Context<AppEnv>,
    itemId: string,
    orgId: string,
  ) => Promise<Record<string, unknown> | null>;
}

// Every AFPS package type exposes user-facing routes. `Partial` is kept so
// the `ROUTE_CONFIGS[type]?.` lookups stay null-tolerant, but all four types are
// wired. `agent`/`skill`/`integration` have JSON-body editors; only `mcp-server`
// is import-only (no editor — authored externally and lands via ZIP).
const ROUTE_CONFIGS: Partial<Record<PackageType, PackageRouteConfig>> = {
  skill: {
    cfg: CONFIG_BY_TYPE.skill,
    path: "skills",
    parseOpts: { requiredFile: "SKILL.md", contentFileExt: null },
    storageFileName: () => "SKILL.md",
    jsonBodyCreate: true,
    requireContent: true,
  },
  agent: {
    cfg: CONFIG_BY_TYPE.agent,
    path: "agents",
    parseOpts: { requiredFile: null, contentFileExt: null },
    storageFileName: () => "prompt.md",
    jsonBodyCreate: true,
    requireContent: true,
    requireMutableForVersionOps: true,
    getHandler: agentDetailHandler,
    // Mutating endpoints echo the full Agent detail (same serializer as the
    // GET). `requireAccess: false` — the caller just wrote this agent in their
    // org, so the app-install gate must not 404 a successful write.
    detailDto: (c, itemId) => buildAgentDetailDto(c, { itemId, requireAccess: false }),
  },
  // Integrations are authored via a JSON-body manifest editor (parity with
  // agents/skills). The stored `manifest.json` content mirrors the DB
  // `draft_manifest` — the runtime reads the manifest from the DB
  // (`fetchIntegrationManifest`), the storage file exists for export/bundle
  // portability. Bundle-backed (`source.kind: "local"`) integrations still
  // arrive via the import pipeline; the editor authors `remote`/`none`
  // sources that need no server bundle.
  integration: {
    cfg: CONFIG_BY_TYPE.integration,
    path: "integrations",
    parseOpts: { requiredFile: null, contentFileExt: null },
    storageFileName: () => "manifest.json",
    jsonBodyCreate: true,
  },
  // AFPS §3.4 — standalone mcp-server packages. Import-only like
  // integrations (no editor): authored externally.
  // AFPS-native manifest carrying MCPB vocabulary fields (server / tools / user_config) verbatim — NOT a strict-MCPB manifest. See AFPS spec §3.4.
  // Listable, viewable, and importable as `.afps` like the other types.
  // Referenced by an integration's `source.kind: "local"`.
  "mcp-server": {
    cfg: CONFIG_BY_TYPE["mcp-server"],
    path: "mcp-servers",
    parseOpts: { requiredFile: null, contentFileExt: null },
    storageFileName: () => "manifest.json",
    jsonBodyCreate: false,
  },
};

// --- Handler factories ---

function makeListHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    // `?active=true` narrows to packages active in this app (agent-editor
    // integration picker). For most types "active" means an installed +
    // enabled `application_packages` row (generic SQL narrowing in
    // `listOrgItems`). INTEGRATIONS additionally auto-activate env-backed
    // SYSTEM integrations that have no row — so they resolve through the
    // canonical activation rule (`resolveIntegrationActivations`), the single
    // source of truth shared with the settings list + detail endpoints, rather
    // than the generic SQL filter (which would hide them).
    const wantActive = c.req.query("active") === "true";
    const isIntegration = rcfg.cfg.type === "integration";
    const items = await listOrgItems(orgId, rcfg.cfg, applicationId, {
      activeOnly: wantActive && !isIntegration,
    });
    let visible = items;
    if (wantActive && isIntegration) {
      const activations = await resolveIntegrationActivations(
        items.map((i) => i.id),
        applicationId,
      );
      visible = items.filter((i) => activations.get(i.id)?.active);
    }
    const enriched = await enrichWithCreatorNames(visible);
    return c.json(listResponse(enriched));
  };
}

function makeCreateHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const orgSlug = c.get("orgSlug");
    const user = c.get("user");

    // JSON body create path: { manifest, content?, source? }
    if (rcfg.jsonBodyCreate) {
      const body = await readJsonBody(c, packageJsonCreateSchema);

      const manifest = body.manifest;
      const content = body.content ?? "";
      const sourceCode = body.source_code ?? "";

      // Validate manifest
      const manifestResult = validateManifest(manifest);
      if (!manifestResult.valid) {
        throw validationFailed(manifestErrorsToFieldErrors(manifestResult.errors));
      }
      const validatedManifest = manifestResult.manifest;
      await assertAgentIntegrationScopesValid(validatedManifest as Record<string, unknown>, orgId);

      if (rcfg.requireContent && !content.trim()) {
        throw invalidRequest("Content cannot be empty", "content");
      }

      if (rcfg.validateContent) {
        const validation = rcfg.validateContent(content);
        if (!validation.valid) {
          throw validationFailed(
            validation.errors.map((message) => ({
              field: "content",
              code: "invalid_content",
              title: "Invalid Content",
              message,
            })),
          );
        }
      }

      if (rcfg.sourceFileName && !sourceCode.trim()) {
        throw invalidRequest("Source is required", "source_code");
      }

      if (rcfg.validateSource && sourceCode) {
        const validation = rcfg.validateSource(sourceCode);
        if (!validation.valid) {
          throw validationFailed(
            validation.errors.map((message) => ({
              field: "source_code",
              code: "invalid_source",
              title: "Invalid Source",
              message,
            })),
          );
        }
      }

      const packageId = validatedManifest.name;

      // Scope no longer gates creation, but a system package id must never be shadowed by an
      // org-owned row — the boot sync upserts system rows by id and would later overwrite it
      // (orgId→null). Mirror the system-package guard the update/delete/version handlers apply.
      if (isSystemPackage(packageId)) {
        throw forbidden(`'${packageId}' is a system package and cannot be created`);
      }

      // Check for name collision
      const existingIds = await getAllPackageIds(orgId);
      if (existingIds.includes(packageId)) {
        throw new ApiError({
          status: 400,
          code: "name_collision",
          title: "Name Collision",
          detail: `A ${rcfg.cfg.type} with identifier '${packageId}' already exists`,
        });
      }

      let createdItem;
      try {
        createdItem = await createOrgItem(
          orgId,
          { id: packageId, content, createdBy: user.id },
          rcfg.cfg,
          validatedManifest as Record<string, unknown>,
        );
      } catch (err) {
        // The pre-check above narrows the common case, but a concurrent create
        // can still lose the race — map the persistence-layer collision to 409
        // instead of a 500 (mirrors the ZIP/skill create path below).
        if (err instanceof PackageAlreadyExistsError) {
          throw conflict("name_collision", err.message);
        }
        throw err;
      }

      // After-create hook (optional per-type post-create side-effect)
      if (rcfg.afterCreate) {
        await rcfg.afterCreate({
          packageId,
          orgId,
          manifest: validatedManifest,
          applicationId: c.get("applicationId"),
        });
      }

      // Upload files to S3 storage
      const normalizedFiles: Record<string, Uint8Array> = {
        [rcfg.storageFileName(packageId)]: new TextEncoder().encode(content),
      };
      if (rcfg.sourceFileName && sourceCode) {
        normalizedFiles[rcfg.sourceFileName(packageId)] = new TextEncoder().encode(sourceCode);
      }
      await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, packageId, normalizedFiles);

      // Create initial version (non-fatal). Snapshot the STORED draft
      // manifest (not the pre-normalization request body): `createOrgItem`
      // injects `$schema`/`type`/… and the jsonb round-trip reorders keys, so
      // snapshotting `validatedManifest` produced a version whose bytes could
      // never match a later rebuild from the draft. That byte drift defeated
      // the publish dedup and, before #896, made every create-then-republish
      // silently overwrite the artifact while keeping the stale integrity row.
      await createVersionSafe({
        packageId,
        orgId,
        userId: user.id,
        manifest: asRecord(createdItem.draftManifest),
        normalizedFiles,
      });

      // Auto-install in the current application (non-fatal)
      const applicationId = c.get("applicationId");
      if (applicationId) {
        await installPackage({ orgId, applicationId }, packageId).catch((e: unknown) =>
          logger.debug("auto-install skipped", { packageId, applicationId, err: String(e) }),
        );
      }

      await recordAuditFromContext(c, {
        action: "package.created",
        resourceType: "package",
        resourceId: packageId,
        after: { type: rcfg.cfg.type, version: validatedManifest.version ?? null },
      });

      // Return the created package resource bare — same DTO/serializer as the
      // GET detail (issue #657). `id` and `lock_version` (the optimistic-lock
      // token of the draft) are part of the resource; no operation envelope.
      const detail = await loadPackageDetailDto(c, rcfg, packageId, orgId);
      if (!detail) {
        logger.error("Created package could not be re-read", { packageId, orgId });
        throw internalError();
      }
      return c.json(detail, 201);
    }

    // Skill/Tool create — uses parsePackageUpload (ZIP or JSON body)
    const parsed = await parsePackageUpload(c, rcfg.parseOpts);

    if (isSystemPackage(parsed.id)) {
      throw forbidden(
        `${rcfg.cfg.label.slice(0, -1)} '${parsed.id}' is a system package and cannot be modified`,
      );
    }

    // Validate manifest if present
    if (parsed.manifest) {
      const manifestResult = validateManifest(parsed.manifest);
      if (!manifestResult.valid) {
        throw validationFailed(manifestErrorsToFieldErrors(manifestResult.errors));
      }
      await assertAgentIntegrationScopesValid(
        manifestResult.manifest as Record<string, unknown>,
        orgId,
      );
    }

    if (rcfg.validateContent) {
      const validation = rcfg.validateContent(parsed.content);
      if (!validation.valid) {
        throw validationFailed(
          validation.errors.map((message) => ({
            field: "content",
            code: "invalid_content",
            title: "Invalid Content",
            message,
          })),
        );
      }
    }

    // Merge user-specified version into manifest for createOrgItem
    const effectiveManifest = parsed.manifest
      ? parsed.manifest
      : parsed.version
        ? { version: parsed.version }
        : undefined;

    let item;
    try {
      item = await createOrgItem(
        orgId,
        {
          id: `@${orgSlug}/${parsed.id}`,
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          createdBy: user.id,
        },
        rcfg.cfg,
        effectiveManifest,
      );
    } catch (err) {
      if (err instanceof PackageAlreadyExistsError) {
        throw conflict("name_collision", err.message);
      }
      throw err;
    }

    if (parsed.normalizedFiles) {
      await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, item.id, parsed.normalizedFiles);
    }

    // After-create hook
    if (rcfg.afterCreate) {
      const finalManifest = asRecord(item.draftManifest);
      await rcfg.afterCreate({
        packageId: item.id,
        orgId,
        manifest: finalManifest,
        applicationId: c.get("applicationId"),
      });
    }

    // Create initial version (non-fatal)
    const finalManifest = asRecord(item.draftManifest);
    await createVersionSafe({
      packageId: item.id,
      orgId,
      userId: user.id,
      manifest: finalManifest,
      normalizedFiles: parsed.normalizedFiles ?? {},
    });

    // Auto-install in the current application (non-fatal)
    const applicationId = c.get("applicationId");
    if (applicationId) {
      await installPackage({ orgId, applicationId }, item.id).catch((e: unknown) =>
        logger.debug("auto-install skipped", { packageId: item.id, applicationId, err: String(e) }),
      );
    }

    await recordAuditFromContext(c, {
      action: "package.created",
      resourceType: "package",
      resourceId: item.id,
      after: { type: rcfg.cfg.type, version: finalManifest.version ?? null },
    });

    // Return the created package resource bare — same serializer as the GET
    // detail (issue #657). `id` and `lock_version` are part of the resource.
    const detail = await loadPackageDetailDto(c, rcfg, item.id, orgId);
    if (!detail) {
      logger.error("Created package could not be re-read", { packageId: item.id, orgId });
      throw internalError();
    }
    return c.json(detail, 201);
  };
}

/** Extract item ID from either `:id` (unscoped) or `:scope/:name` (scoped) route params. */
export function getItemId(c: Context<AppEnv>): string {
  const scope = c.req.param("scope");
  const name = c.req.param("name");
  if (scope && name) return `${scope}/${name}`;
  return c.req.param("id")!;
}

/**
 * Build the canonical package detail DTO for skills / integrations / mcp-servers
 * — the exact object the `GET` detail endpoint serializes (`OrgPackageItemDetail`).
 * Org-scoped (no app-install gate): the GET handler applies that gate before
 * calling this, while mutating endpoints (create / update / fork) reuse this
 * directly to echo what the caller just wrote (issue #646). Returns `null` when
 * the package is not found in the org.
 */
async function buildPackageDetailDto(
  rcfg: PackageRouteConfig,
  itemId: string,
  orgId: string,
): Promise<Record<string, unknown> | null> {
  const [item, versionCount, latestVersionDate] = await Promise.all([
    getOrgItem(orgId, itemId, rcfg.cfg),
    getVersionCount(itemId),
    getLatestVersionCreatedAt(itemId),
  ]);

  if (!item) return null;

  // Extract secondary source file from S3 storage (e.g. .ts for tools)
  let sourceText: string | null = null;
  if (rcfg.sourceFileName) {
    const files = await downloadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId);
    const sourceData = files?.[rcfg.sourceFileName(itemId)];
    if (sourceData) {
      sourceText = new TextDecoder().decode(sourceData);
    }
  }

  return {
    ...item,
    ...(sourceText != null ? { source_code: sourceText } : {}),
    version_count: versionCount,
    has_unarchived_changes: computeHasUnpublishedChanges(
      item.source,
      versionCount,
      item.updatedAt ? new Date(item.updatedAt) : null,
      latestVersionDate,
    ),
  };
}

/**
 * Resolve the package detail DTO a mutating endpoint should echo — the agent's
 * richer Agent detail when configured (`rcfg.detailDto`), otherwise the generic
 * package detail. Single source of truth so create / update / fork stay in
 * lockstep with their respective GET serializers.
 */
function loadPackageDetailDto(
  c: Context<AppEnv>,
  rcfg: PackageRouteConfig,
  itemId: string,
  orgId: string,
): Promise<Record<string, unknown> | null> {
  return rcfg.detailDto
    ? rcfg.detailDto(c, itemId, orgId)
    : buildPackageDetailDto(rcfg, itemId, orgId);
}

function makeGetHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    const itemId = getItemId(c);

    // Enforce app-level access: all apps can only access installed packages
    if (!(await hasPackageAccess({ orgId, applicationId }, itemId))) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }

    const dto = await buildPackageDetailDto(rcfg, itemId, orgId);
    if (!dto) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }

    return c.json(dto);
  };
}

function makeUpdateHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${label} '${itemId}' is a system package and cannot be modified`);
    }

    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing) {
      throw notFound(`${label} '${itemId}' not found`);
    }

    const body = await readJsonBody(c, packageJsonUpdateSchema);

    if (body.lock_version == null || typeof body.lock_version !== "number") {
      throw invalidRequest("lock_version (integer) is required for updates", "lock_version");
    }

    const manifest =
      body.manifest ?? (existing as { manifest?: Record<string, unknown> }).manifest ?? {};
    const content = body.content ?? existing.content ?? "";
    const sourceCode = body.source_code;

    // Validate manifest
    const manifestResult = validateManifest(manifest);
    if (!manifestResult.valid) {
      throw validationFailed(manifestErrorsToFieldErrors(manifestResult.errors));
    }
    await assertAgentIntegrationScopesValid(
      manifestResult.manifest as Record<string, unknown>,
      orgId,
    );

    // Ensure ID immutability (all types)
    const newScopedName = (manifest as { name?: string }).name;
    if (newScopedName && newScopedName !== itemId) {
      throw invalidRequest("name cannot change", "name");
    }

    // Content required check
    if (rcfg.requireContent && !content.trim()) {
      throw invalidRequest("Content cannot be empty", "content");
    }

    // Content validation
    if (rcfg.validateContent && content) {
      const validation = rcfg.validateContent(content);
      if (!validation.valid) {
        throw validationFailed(
          validation.errors.map((message) => ({
            field: "content",
            code: "invalid_content",
            title: "Invalid Content",
            message,
          })),
        );
      }
    }

    // Source validation (tools)
    if (rcfg.sourceFileName && sourceCode !== undefined) {
      if (!sourceCode.trim()) {
        throw invalidRequest("Source cannot be empty", "source_code");
      }
      if (rcfg.validateSource) {
        const validation = rcfg.validateSource(sourceCode);
        if (!validation.valid) {
          throw validationFailed(
            validation.errors.map((message) => ({
              field: "source_code",
              code: "invalid_source",
              title: "Invalid Source",
              message,
            })),
          );
        }
      }
    }

    const updated = await updateOrgItem(
      orgId,
      itemId,
      { manifest: manifest as Record<string, unknown>, content },
      body.lock_version,
    );

    if (!updated) {
      throw conflict("conflict", `${label} was modified concurrently. Reload and try again.`);
    }

    // Update storage files (merge with existing to preserve ancillary files)
    const existingFiles = await downloadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId);
    const updatedFiles: Record<string, Uint8Array> = {
      ...(existingFiles ?? {}),
      [rcfg.storageFileName(itemId)]: new TextEncoder().encode(content),
    };
    if (rcfg.sourceFileName && sourceCode !== undefined) {
      updatedFiles[rcfg.sourceFileName(itemId)] = new TextEncoder().encode(sourceCode);
    }
    await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId, updatedFiles);

    // After-update hook (e.g. agent junction table sync)
    if (rcfg.afterUpdate) {
      await rcfg.afterUpdate({
        packageId: itemId,
        orgId,
        manifest: manifest as Record<string, unknown>,
      });
    }

    await recordAuditFromContext(c, {
      action: "package.updated",
      resourceType: "package",
      resourceId: itemId,
      after: { type: rcfg.cfg.type },
    });

    // Return the updated package resource bare — same serializer as the GET
    // detail (issue #657). The resource carries `lock_version`, the NEW
    // optimistic-lock token consumers must read back for the next edit.
    const detail = await loadPackageDetailDto(c, rcfg, itemId, orgId);
    if (!detail) {
      logger.error("Updated package could not be re-read", { packageId: itemId, orgId });
      throw internalError();
    }
    return c.json(detail);
  };
}

/**
 * Reject (409) when an agent package has runs in progress. No-op for package
 * types that don't gate version/delete ops on running runs (skills/tools, where
 * `requireMutableForVersionOps` is unset). Shared by the delete / create-version
 * / restore-version / delete-version handlers so the conflict message + the
 * `(orgId, applicationId)` scoping stay identical across all four.
 */
async function assertNoRunningRuns(
  c: Context<AppEnv>,
  rcfg: PackageRouteConfig,
  itemId: string,
): Promise<void> {
  if (!rcfg.requireMutableForVersionOps) return;
  const running = await getRunningRunsForPackage(
    { orgId: c.get("orgId"), applicationId: c.get("applicationId") },
    itemId,
  );
  if (running > 0) {
    const label = rcfg.cfg.label.slice(0, -1);
    throw conflict(
      "agent_in_use",
      `${running} run(s) still running for this ${label.toLowerCase()}`,
    );
  }
}

function makeDeleteHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${label} '${itemId}' is a system package and cannot be deleted`);
    }

    await assertNoRunningRuns(c, rcfg, itemId);

    const result = await deleteOrgItem(orgId, itemId, rcfg.cfg);
    if (!result.ok) {
      throw conflict(
        "in_use",
        `${label} '${itemId}' is used by ${result.dependents!.length} package(s)`,
      );
    }

    await recordAuditFromContext(c, {
      action: "package.deleted",
      resourceType: "package",
      resourceId: itemId,
      after: { type: rcfg.cfg.type },
    });

    return c.body(null, 204);
  };
}

function makeListVersionsHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const item = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!item) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }
    const versions = await listPackageVersions(itemId);
    return c.json({ versions });
  };
}

/**
 * Build the canonical version detail DTO — the exact object the `GET` version
 * detail endpoint serializes. Reused by the version create / restore endpoints
 * so they echo the resulting version resource instead of an id/message stub
 * (issue #646). Returns `null` when the version query resolves nothing.
 */
async function buildVersionDetailDto(
  rcfg: PackageRouteConfig,
  itemId: string,
  versionSpec: string,
): Promise<Record<string, unknown> | null> {
  const detail = await getVersionDetail(itemId, versionSpec);
  if (!detail) return null;

  const matchingTags = await getMatchingDistTags(itemId, detail.version);

  // Extract primary content file from the ZIP
  let content: string | null = null;
  let sourceText: string | null = null;
  if (detail.content) {
    const fileName = rcfg.storageFileName(itemId);
    const fileData = detail.content[fileName];
    if (fileData) {
      content = new TextDecoder().decode(fileData);
    }
    if (rcfg.sourceFileName) {
      const sourceData = detail.content[rcfg.sourceFileName(itemId)];
      if (sourceData) {
        sourceText = new TextDecoder().decode(sourceData);
      }
    }
  }

  return {
    id: detail.id,
    version: detail.version,
    manifest: detail.manifest,
    content,
    ...(sourceText != null ? { source_code: sourceText } : {}),
    yanked: detail.yanked,
    yanked_reason: detail.yankedReason,
    integrity: detail.integrity,
    artifact_size: detail.artifactSize,
    createdAt: detail.createdAt,
    dist_tags: matchingTags,
  };
}

function makeVersionDetailHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const versionSpec = c.req.param("version")!;

    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }

    const dto = await buildVersionDetailDto(rcfg, itemId, versionSpec);
    if (!dto) {
      throw notFound(`Version '${versionSpec}' not found`);
    }

    return c.json(dto);
  };
}

function makeVersionInfoHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const item = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!item) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }
    const info = await getVersionInfo(itemId, orgId);
    return c.json(info);
  };
}

function makeCreateVersionHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${label} '${itemId}' is a system package`);
    }

    await assertNoRunningRuns(c, rcfg, itemId);

    const item = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!item) {
      throw notFound(`${label} '${itemId}' not found`);
    }

    // Re-validate the draft manifest at the publish gate (defense in depth).
    // Save/import already validate, but cutting a version must not trust a
    // draft that became invalid by any path — this rejects e.g. an
    // `integrations_configuration` entry without a matching declared
    // dependency before it is frozen into an immutable version.
    const manifestResult = validateManifest(item.manifest);
    if (!manifestResult.valid) {
      throw validationFailed(manifestErrorsToFieldErrors(manifestResult.errors));
    }
    // Same integration-scope subset gate the create/update paths apply — a
    // draft must not be frozen into an immutable version with an
    // `integrations_configuration` selection outside the integration catalog.
    await assertAgentIntegrationScopesValid(
      manifestResult.manifest as Record<string, unknown>,
      orgId,
    );

    // Parse optional version override from request body. The body itself is
    // optional (OpenAPI `requestBody.required: false` — the SPA omits it
    // entirely when no override is chosen), so only read it when present;
    // a present-but-malformed body is a 400, not a silent no-override.
    let versionOverride: string | undefined;
    if (c.req.raw.body !== null) {
      const body = await readJsonBody(c, z.object({ version: z.string().min(1).optional() }));
      versionOverride = body.version;
    }

    const result = await createVersionFromDraft({
      packageId: itemId,
      orgId,
      userId: user.id,
      version: versionOverride,
    });

    if ("error" in result) {
      if (result.error === "no_changes") {
        throw conflict("no_changes", "No changes since the last version");
      }
      if (result.error === "version_exists") {
        throw conflict(
          "version_exists",
          "This version is already published and immutable — bump the version to publish the changed content",
        );
      }
      throw invalidRequest("Failed to create version (invalid or duplicate)");
    }

    await recordAuditFromContext(c, {
      action: "package.version_created",
      resourceType: "package",
      resourceId: itemId,
      after: { type: rcfg.cfg.type, version: result.version },
    });

    // Return the created version resource bare — same DTO/serializer as the
    // GET version detail — so callers see the snapshot (manifest, integrity,
    // dist_tags, …) without a follow-up GET (issue #657). `id` (version row
    // id) and `version` are part of the resource.
    const detail = await buildVersionDetailDto(rcfg, itemId, result.version);
    if (!detail) {
      logger.error("Created version could not be re-read", { packageId: itemId, orgId });
      throw internalError();
    }
    return c.json(detail, 201);
  };
}

function makeRestoreVersionHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${label} '${itemId}' is a system package`);
    }

    await assertNoRunningRuns(c, rcfg, itemId);

    const versionSpec = c.req.param("version")!;
    const detail = await getVersionDetail(itemId, versionSpec);
    if (!detail) {
      throw notFound(`Version '${versionSpec}' not found`);
    }

    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing || !existing.lock_version) {
      throw notFound(`${label} '${itemId}' not found`);
    }

    // Extract content from version ZIP
    let content = detail.prompt ?? "";
    if (detail.content) {
      const fileName = rcfg.storageFileName(itemId);
      const fileData = detail.content[fileName];
      if (fileData) {
        content = new TextDecoder().decode(fileData);
      }
    }

    const updated = await updateOrgItem(
      orgId,
      itemId,
      { manifest: detail.manifest, content },
      existing.lock_version,
    );

    if (!updated) {
      throw conflict("conflict", "Package was modified concurrently. Reload and try again.");
    }

    // If restoring the latest version, align updatedAt so the draft
    // doesn't appear as having unpublished changes.
    const latestDate = await getLatestVersionCreatedAt(itemId);
    if (
      latestDate &&
      detail.createdAt &&
      new Date(detail.createdAt).getTime() === latestDate.getTime()
    ) {
      await db
        .update(packages)
        .set({ updatedAt: latestDate })
        .where(and(eq(packages.id, itemId), eq(packages.orgId, orgId)));
    }

    // Re-upload storage files from the version ZIP
    if (detail.content) {
      await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId, detail.content);
    }

    // After-update hook (e.g. agent junction table sync on restore)
    if (rcfg.afterUpdate) {
      await rcfg.afterUpdate({
        packageId: itemId,
        orgId,
        manifest: detail.manifest,
      });
    }

    await recordAuditFromContext(c, {
      action: "package.version_restored",
      resourceType: "package",
      resourceId: itemId,
      after: { type: rcfg.cfg.type, version: detail.version },
    });

    // Restore mutates the package draft — return the updated PACKAGE resource
    // bare, same DTO/serializer as the package GET detail (issue #657). The
    // restored version info is reflected in the resource itself (`version`,
    // `manifest`, `content`), and the resource carries `lock_version`, the
    // package's NEW optimistic-lock token to read back before the next edit.
    const packageDto = await loadPackageDetailDto(c, rcfg, itemId, orgId);
    if (!packageDto) {
      logger.error("Restored package could not be re-read", { packageId: itemId, orgId });
      throw internalError();
    }
    return c.json(packageDto);
  };
}

function makeDeleteVersionHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${label} '${itemId}' is a system package`);
    }

    // Verify org ownership before deletion
    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing) {
      throw notFound(`${label} '${itemId}' not found`);
    }

    await assertNoRunningRuns(c, rcfg, itemId);

    const versionSpec = c.req.param("version")!;
    const deleted = await deletePackageVersion(itemId, versionSpec);
    if (!deleted) {
      throw notFound(`Version '${versionSpec}' not found`);
    }

    await recordAuditFromContext(c, {
      action: "package.version_deleted",
      resourceType: "package",
      resourceId: itemId,
      after: { type: rcfg.cfg.type, version: versionSpec },
    });

    return c.body(null, 204);
  };
}

// ═══════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════

export function createPackagesRouter() {
  const router = new Hono<AppEnv>();

  // --- Package CRUD routes (skills, agents, integrations) ---
  for (const rcfg of Object.values(ROUTE_CONFIGS)) {
    if (!rcfg) continue;
    const { path } = rcfg;
    // Permission resource matches the route path (e.g. "skills", "agents", "integrations")
    const resource = path as import("../lib/permissions.ts").Resource;
    const writeGuard = requirePermission(resource, "write");
    const deleteGuard = requirePermission(resource, "delete");

    router.get(`/${path}`, makeListHandler(rcfg));
    router.post(`/${path}`, writeGuard, makeCreateHandler(rcfg));
    // Version routes — must be registered before generic get to avoid conflict
    router.get(`/${path}/${SCOPED_PACKAGE_ROUTE}/versions`, makeListVersionsHandler(rcfg));
    // Version info + create version + restore — BEFORE :version param to avoid matching
    router.get(`/${path}/${SCOPED_PACKAGE_ROUTE}/versions/info`, makeVersionInfoHandler(rcfg));
    router.post(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions`,
      requirePackageInOrg(),
      writeGuard,
      makeCreateVersionHandler(rcfg),
    );
    router.post(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions/:version/restore`,
      requirePackageInOrg(),
      writeGuard,
      makeRestoreVersionHandler(rcfg),
    );
    router.delete(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions/:version`,
      requirePackageInOrg(),
      deleteGuard,
      makeDeleteVersionHandler(rcfg),
    );
    router.get(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions/:version`,
      makeVersionDetailHandler(rcfg),
    );
    // Scoped IDs (@scope/name) — must be registered before unscoped to match first
    router.get(`/${path}/${SCOPED_PACKAGE_ROUTE}`, rcfg.getHandler ?? makeGetHandler(rcfg));
    router.put(
      `/${path}/${SCOPED_PACKAGE_ROUTE}`,
      requirePackageInOrg(),
      writeGuard,
      makeUpdateHandler(rcfg),
    );
    router.delete(
      `/${path}/${SCOPED_PACKAGE_ROUTE}`,
      requirePackageInOrg(),
      deleteGuard,
      makeDeleteHandler(rcfg),
    );
    // Unscoped IDs
    router.get(`/${path}/:id`, rcfg.getHandler ?? makeGetHandler(rcfg));
    router.put(`/${path}/:id`, requirePackageInOrg(), writeGuard, makeUpdateHandler(rcfg));
    router.delete(`/${path}/:id`, requirePackageInOrg(), deleteGuard, makeDeleteHandler(rcfg));
  }

  // --- Fork route ---
  router.post(`/${SCOPED_PACKAGE_ROUTE}/fork`, requirePermission("agents", "write"), async (c) => {
    const packageId = getItemId(c);
    const orgId = c.get("orgId");
    const orgSlug = c.get("orgSlug");
    const user = c.get("user");

    // A missing/empty body is fine (auto-name), but a present-and-invalid
    // `name` must surface as a 400 — `allowEmpty` maps an empty body to `{}`
    // while still 400ing on malformed JSON or a bad-shape `name`.
    const parsed = await readJsonBody(c, forkSchema, { allowEmpty: true });
    const customName = parsed.name;

    const result = await forkPackage(orgId, orgSlug, packageId, user.id, customName);

    if ("code" in result) {
      switch (result.code) {
        case "ALREADY_OWNED":
          throw invalidRequest("You already own this package");
        case "NOT_FOUND":
          throw notFound("Package not found");
        case "NAME_COLLISION":
          throw new ApiError({
            status: 400,
            code: "name_collision",
            title: "Name Collision",
            detail: "A package with this name already exists in your organization",
          });
        case "UNKNOWN_TYPE":
          throw invalidRequest(`Unsupported package type: ${result.type}`);
        case "NO_PUBLISHED_VERSION":
          throw invalidRequest("Source package has no published version");
      }
    }

    // Auto-install the forked package in the current application (non-fatal)
    const applicationId = c.get("applicationId");
    if (applicationId) {
      await installPackage({ orgId, applicationId }, result.packageId).catch((e: unknown) =>
        logger.debug("auto-install skipped", {
          packageId: result.packageId,
          applicationId,
          err: String(e),
        }),
      );
    }

    await recordAuditFromContext(c, {
      action: "package.forked",
      resourceType: "package",
      resourceId: result.packageId,
      after: { type: result.type, forkedFrom: packageId },
    });

    // Return the forked package resource bare — same DTO/serializer as the new
    // package's GET detail, selected by its type (issue #657). The fork
    // provenance is resource state: `forked_from` is part of the detail DTO.
    const forkedRcfg = ROUTE_CONFIGS[result.type as PackageType];
    const detail = forkedRcfg
      ? await loadPackageDetailDto(c, forkedRcfg, result.packageId, orgId)
      : null;
    if (!detail) {
      logger.error("Forked package could not be re-read", {
        packageId: result.packageId,
        type: result.type,
        orgId,
      });
      throw internalError();
    }
    return c.json(detail, 201);
  });

  // --- Package import/download/publish routes ---

  // --- Shared import logic (used by /import and /import-github) ---

  async function parseZipWithSkillFallback(
    zipBytes: Uint8Array,
    orgSlug: string,
  ): Promise<ReturnType<typeof parsePackageZip>> {
    try {
      return parsePackageZip(zipBytes);
    } catch (err) {
      if (err instanceof PackageZipError && err.code === "MISSING_MANIFEST") {
        const result = await tryParseSkillOnlyZip(zipBytes, orgSlug);
        if (result.ok) {
          return result.parsed;
        }
        if (result.reason === "unchanged") {
          throw conflict("skill_unchanged", "This skill already exists with the same content");
        }
        throw new ApiError({
          status: 400,
          code: err.code.toLowerCase(),
          title: "Package Error",
          detail: err.message,
        });
      }
      if (err instanceof PackageZipError) {
        throw new ApiError({
          status: 400,
          code: err.code.toLowerCase(),
          title: "Package Error",
          detail: err.message,
        });
      }
      throw err;
    }
  }

  async function handleImport(
    c: Context<AppEnv>,
    parsed: ReturnType<typeof parsePackageZip>,
    buffer: Buffer,
    force: boolean,
    source: "zip" | "github",
  ) {
    const user = c.get("user");
    const orgId = c.get("orgId");
    const { manifest, content, files, type: packageType, packageId } = parsed;

    // System packages are immutable
    if (isSystemPackage(packageId)) {
      throw new ApiError({
        status: 400,
        code: "name_collision",
        title: "Name Collision",
        detail: `'${packageId}' is a system package and cannot be overwritten`,
      });
    }

    // Phase 1 — for agent imports, cross-check integrations_configuration
    // selections against the referenced integration catalogs. `parsePackageZip`
    // already ran `validateManifest`; this is the niveau 2 follow-up.
    await assertAgentIntegrationScopesValid(manifest as Record<string, unknown>, orgId);

    // Check for existing user package
    const existing = await getPackageById(packageId);

    if (existing) {
      if (existing.orgId !== orgId) {
        throw new ApiError({
          status: 400,
          code: "name_collision",
          title: "Name Collision",
          detail: `A package with identifier '${packageId}' already exists`,
        });
      }
      if (existing.type !== packageType) {
        throw new ApiError({
          status: 400,
          code: "type_mismatch",
          title: "Type Mismatch",
          detail: `Package '${packageId}' exists as type '${existing.type}', cannot import as '${packageType}'`,
        });
      }
      // Draft overwrite protection
      if (!force) {
        const [vCount, latestDate] = await Promise.all([
          getVersionCount(packageId),
          getLatestVersionCreatedAt(packageId),
        ]);
        if (
          computeHasUnpublishedChanges(
            existing.source,
            vCount,
            existing.updatedAt ?? null,
            latestDate,
          )
        ) {
          throw conflict(
            "draft_overwrite",
            "This package has unpublished changes that will be overwritten by the import.",
          );
        }
      }

      // Integrity mismatch detection — same version, different content
      const importedVersion = (manifest as Record<string, unknown>).version as string | undefined;
      if (!force && importedVersion) {
        const existingVer = await getVersionForDownload(packageId, importedVersion);
        if (existingVer) {
          const importedIntegrity = computeIntegrity(new Uint8Array(buffer));
          if (existingVer.integrity !== importedIntegrity) {
            throw conflict(
              "integrity_mismatch",
              "This version already exists with different content. Use the force option to replace.",
            );
          }
        }
      }

      // Update existing package manifest and content
      await db
        .update(packages)
        .set({ draftManifest: manifest, draftContent: content, updatedAt: new Date() })
        .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)));
    } else {
      // New package — insert
      const cfg = ROUTE_CONFIGS[packageType as PackageType]?.cfg;
      if (!cfg) {
        throw invalidRequest(`Unknown package type '${packageType}'`);
      }
      try {
        await createOrgItem(
          orgId,
          { id: packageId, content, createdBy: user.id },
          cfg,
          manifest as Record<string, unknown>,
        );
      } catch (err) {
        if (err instanceof PackageAlreadyExistsError) {
          throw conflict("name_collision", err.message);
        }
        throw err;
      }
    }

    // Per-type post-install (version, package upsert, storage upload)
    try {
      await postInstallPackage({
        packageType,
        packageId,
        orgId,
        userId: user.id,
        content,
        files,
        zipBuffer: buffer,
      });
    } catch (err) {
      const message = getErrorMessage(err);
      logger.error("Post-install failed", { packageId, packageType, error: message });
      throw new ApiError({
        status: 400,
        code: "post_install_failed",
        title: "Post-Install Failed",
        detail: message,
      });
    }

    // After-create hook (e.g. auto-enable provider)
    const rcfg = ROUTE_CONFIGS[packageType as PackageType];
    if (rcfg?.afterCreate) {
      await rcfg.afterCreate({
        packageId,
        orgId,
        manifest: manifest as Record<string, unknown>,
        applicationId: c.get("applicationId"),
      });
    }

    // Auto-install in the current application (non-fatal, skip if already installed)
    const applicationId = c.get("applicationId");
    if (applicationId) {
      await installPackage({ orgId, applicationId }, packageId).catch((e: unknown) =>
        logger.debug("auto-install skipped", { packageId, applicationId, err: String(e) }),
      );
    }

    // Force import: replace existing version content if integrity differs
    const importedVersionForReplace = (manifest as Record<string, unknown>).version as
      | string
      | undefined;
    if (existing && force && importedVersionForReplace) {
      const existingVer = await getVersionForDownload(packageId, importedVersionForReplace);
      if (existingVer) {
        const importedIntegrity = computeIntegrity(new Uint8Array(buffer));
        if (existingVer.integrity !== importedIntegrity) {
          await replaceVersionContent({
            packageId,
            version: importedVersionForReplace,
            zipBuffer: buffer,
            manifest: manifest as Record<string, unknown>,
          });
        }
      }
    }

    logger.info("Package imported", { packageId, type: packageType, orgId });
    const importedVersion = (manifest as Record<string, unknown>).version as string | undefined;
    await recordAuditFromContext(c, {
      action: existing ? "package.updated" : "package.created",
      resourceType: "package",
      resourceId: packageId,
      after: {
        type: packageType,
        version: importedVersion ?? null,
        via: `import:${source}`,
        force,
      },
    });
    // Surface engine-subset limitations for integration manifests as
    // non-blocking warnings (AFPS §7.7). Publishers learn
    // about unsupported `connect.login` selectors / criteria at install
    // time rather than chasing the runtime LoginError later. Also lift the
    // validator's `_meta` Appendix B regex soft-fail warnings to the same
    // channel so publishers see them on import.
    const installWarnings = [
      ...collectConnectLoginWarnings(manifest),
      ...collectMetaWarnings(manifest),
    ];
    return c.json(
      {
        packageId,
        type: packageType,
        version: importedVersion,
        ...(installWarnings.length > 0 ? { warnings: installWarnings } : {}),
      },
      201,
    );
  }

  // POST /api/packages/import-bundle — import a multi-package .afps-bundle
  // (or a raw .afps, promoted to a bundle-of-one via the catalog).
  router.post("/import-bundle", rateLimit(10), requirePermission("agents", "write"), async (c) => {
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      throw invalidRequest("Request must be multipart/form-data with a file field", "file");
    }
    const file = formData.get("file") ?? formData.get("bundle");
    if (!file || !(file instanceof File)) {
      throw invalidRequest("File is required", "file");
    }
    const ext = file.name.toLowerCase();
    if (!ext.endsWith(".afps-bundle") && !ext.endsWith(".afps") && !ext.endsWith(".zip")) {
      throw invalidRequest("Only .afps-bundle, .afps, and .zip files are accepted", "file");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    const userId = c.get("user").id;

    let result: Awaited<ReturnType<typeof handleImportBundle>>;
    try {
      result = await handleImportBundle(bytes, { orgId, applicationId }, userId);
    } catch (err) {
      // Typed errors (ApiError — conflicts, invalid request) propagate as-is.
      // A raw post-install/version-creation failure becomes the same clean 4xx
      // as the single-import route rather than a 500.
      if (err instanceof ApiError) throw err;
      const message = getErrorMessage(err);
      logger.error("Bundle import post-install failed", { orgId, error: message });
      throw new ApiError({
        status: 400,
        code: "post_install_failed",
        title: "Post-Install Failed",
        detail: message,
      });
    }
    // One audit event per package version actually written — "reused"
    // entries changed no state. `recordAudit*` never throws.
    for (const entry of result.imported) {
      if (entry.status !== "inserted") continue;
      const identity = parsePackageIdentity(entry.identity);
      await recordAuditFromContext(c, {
        action: "package.version_created",
        resourceType: "package",
        resourceId: identity?.packageId ?? entry.identity,
        after: {
          type: entry.type ?? null,
          version: identity?.version ?? null,
          via: "import:bundle",
          root: entry.identity === `${result.root_package_id}@${result.root_version}`,
        },
      });
    }
    return c.json(result, 201);
  });

  // POST /api/packages/import — import any package type from ZIP
  router.post("/import", rateLimit(10), requirePermission("agents", "write"), async (c) => {
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      throw invalidRequest("Request must be multipart/form-data with a file field", "file");
    }
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      throw invalidRequest("No file provided");
    }
    if (!file.name.endsWith(".afps") && !file.name.endsWith(".zip")) {
      throw invalidRequest("Only .afps and .zip files are accepted");
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const zipBytes = new Uint8Array(buffer);

    const parsed = await parseZipWithSkillFallback(zipBytes, c.get("orgSlug"));

    return handleImport(c, parsed, buffer, c.req.query("force") === "true", "zip");
  });

  // POST /api/packages/import-github — import a package from a GitHub URL
  router.post("/import-github", rateLimit(10), requirePermission("agents", "write"), async (c) => {
    const data = await readJsonBody(c, githubImportSchema, "url");

    let zipBytes: Uint8Array;
    try {
      zipBytes = await fetchGithubDirectory(data.url);
    } catch (err) {
      if (err instanceof GithubImportError) {
        throw new ApiError({
          status: 400,
          code: err.code,
          title: "Import Failed",
          detail: err.message,
        });
      }
      throw err;
    }

    const buffer = Buffer.from(zipBytes);

    const parsed = await parseZipWithSkillFallback(zipBytes, c.get("orgSlug"));

    return handleImport(c, parsed, buffer, false, "github");
  });

  // GET /api/packages/:scope/:name/:version/download — download a versioned package ZIP
  router.get(`/${SCOPED_PACKAGE_ROUTE}/:version/download`, rateLimit(50), async (c) => {
    const packageId = getItemId(c);
    const orgId = c.get("orgId");
    const versionSpec = c.req.param("version")!;

    // Verify org ownership (or system package). Ephemeral shadows are hidden.
    const [pkg] = await db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId), notEphemeralFilter()))
      .limit(1);
    if (!pkg) {
      throw notFound("Package not found");
    }

    const ver = await getVersionForDownload(packageId, versionSpec);
    if (!ver) {
      throw notFound("Version not found");
    }

    let data: Buffer | null;
    try {
      data = await downloadVersionZip(packageId, ver.version, ver.integrity);
    } catch {
      throw internalError();
    }
    if (!data) {
      throw notFound("Artifact not found in storage");
    }

    const downloadHeaders = buildDownloadHeaders({
      integrity: ver.integrity,
      yanked: ver.yanked,
      scope: c.req.param("scope")!,
      name: c.req.param("name")!,
      version: ver.version,
    });
    return new Response(new Uint8Array(data), { status: 200, headers: downloadHeaders });
  });

  return router;
}
