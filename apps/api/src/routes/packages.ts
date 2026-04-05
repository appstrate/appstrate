// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { parsePackageZip, PackageZipError, zipArtifact } from "@appstrate/core/zip";
import { buildDownloadHeaders } from "@appstrate/core/integrity";
import { eq, and, inArray } from "drizzle-orm";
import { packages, profiles, applicationProviderCredentials } from "@appstrate/db/schema";
import { db } from "@appstrate/db/client";
import { postInstallPackage } from "../services/post-install-package.ts";
import { installPackage } from "../services/application-packages.ts";
import { parseManifestBytesSafe } from "../lib/manifest-parser.ts";
import { getAllPackageIds } from "../services/agent-service.ts";
import { isSystemPackage } from "../services/system-packages.ts";
import { orgOrSystemFilter } from "../lib/package-helpers.ts";
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
  uploadPackageFiles,
  downloadPackageFiles,
  SKILL_CONFIG,
  TOOL_CONFIG,
  AGENT_CONFIG,
  PROVIDER_CONFIG,
  PackageAlreadyExistsError,
  type PackageTypeConfig,
} from "../services/package-items/index.ts";
import { validateToolSource, validateManifest, type PackageType } from "@appstrate/core/validation";
import { parseScopedName, SLUG_REGEX } from "@appstrate/core/naming";
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
import { agentDetailHandler } from "./agent-detail-handler.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireOwnedPackage, requireOrgPackage, checkScopeMatch } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getRunningRunsForPackage } from "../services/state/index.ts";
import { logger } from "../lib/logger.ts";
import { asRecord } from "../lib/safe-json.ts";
import { forkPackage } from "../services/package-fork.ts";
import { tryParseSkillOnlyZip } from "../services/skill-zip.ts";
import { fetchGithubDirectory, GithubImportError } from "../services/github-import.ts";
import {
  ApiError,
  invalidRequest,
  forbidden,
  notFound,
  conflict,
  internalError,
  parseBody,
} from "../lib/errors.ts";

// ═══════════════════════════════════════════════
// Shared helpers for package CRUD routes
// ═══════════════════════════════════════════════

const githubImportSchema = z.object({
  url: z.url("Missing 'url' field"),
});

const forkSchema = z
  .object({
    name: z.string().regex(SLUG_REGEX, "Name must match slug format").optional(),
  })
  .catch({});

/** Enrich items with creator display names (batch lookup). */
async function enrichWithCreatorNames<T extends { createdBy?: string | null }>(
  items: T[],
): Promise<(T & { createdByName?: string })[]> {
  const userIds = [...new Set(items.map((i) => i.createdBy).filter(Boolean))] as string[];
  if (userIds.length === 0) return items;

  const rows = await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .where(inArray(profiles.id, userIds));

  const nameMap = new Map(rows.map((p) => [p.id, p.displayName]));

  return items.map((item) => ({
    ...item,
    createdByName: item.createdBy ? (nameMap.get(item.createdBy) ?? undefined) : undefined,
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
        if (!name && typeof manifest.displayName === "string") name = manifest.displayName;
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
  const body = await c.req.json<{
    id: string;
    content: string;
    manifest?: Record<string, unknown>;
    name?: string;
    description?: string;
    version?: string;
  }>();

  if (!body.id || !body.content) {
    throw invalidRequest("id and content are required");
  }

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
 *  Builds the ZIP from normalizedFiles + manifest.json, then uploads. */
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
    const entries: Record<string, Uint8Array> = { ...params.normalizedFiles };
    entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(params.manifest, null, 2));
    const zipBuffer = Buffer.from(zipArtifact(entries, 6));

    await createVersionAndUpload({
      packageId: params.packageId,
      version,
      createdBy: params.userId,
      zipBuffer,
      manifest: params.manifest,
    });
  } catch (error) {
    logger.warn("Version upload failed (non-fatal)", { packageId: params.packageId, error });
  }
}

// --- Route configuration per package type ---

interface PackageRouteConfig {
  cfg: PackageTypeConfig;
  /** URL path segment used for routing (e.g. "skills", "providers"). */
  path: string;
  parseOpts: {
    requiredFile: string | null;
    contentFileExt: string | null;
  };
  responseKey: string;
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
}

const ROUTE_CONFIGS: Record<PackageType, PackageRouteConfig> = {
  skill: {
    cfg: SKILL_CONFIG,
    path: "skills",
    parseOpts: { requiredFile: "SKILL.md", contentFileExt: null },
    responseKey: "skill",
    storageFileName: () => "SKILL.md",
    jsonBodyCreate: true,
    requireContent: true,
  },
  tool: {
    cfg: TOOL_CONFIG,
    path: "tools",
    parseOpts: { requiredFile: null, contentFileExt: ".ts" },
    responseKey: "tool",
    validateSource: validateToolSource,
    storageFileName: () => "TOOL.md",
    sourceFileName: (id) => `${parseScopedName(id)?.name ?? id}.ts`,
    jsonBodyCreate: true,
  },
  agent: {
    cfg: AGENT_CONFIG,
    path: "agents",
    parseOpts: { requiredFile: null, contentFileExt: null },
    responseKey: "agent",
    storageFileName: () => "prompt.md",
    jsonBodyCreate: true,
    requireContent: true,
    requireMutableForVersionOps: true,
    getHandler: agentDetailHandler,
  },
  provider: {
    cfg: PROVIDER_CONFIG,
    path: "providers",
    parseOpts: { requiredFile: null, contentFileExt: null },
    responseKey: "provider",
    storageFileName: () => "PROVIDER.md",
    jsonBodyCreate: true,
    afterCreate: async ({ packageId, applicationId }) => {
      if (applicationId) {
        await db
          .insert(applicationProviderCredentials)
          .values({
            applicationId,
            providerId: packageId,
            credentialsEncrypted: null,
            enabled: true,
          })
          .onConflictDoNothing();
      }
    },
  },
};

// --- Handler factories ---

function makeListHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const items = await listOrgItems(orgId, rcfg.cfg);
    const enriched = await enrichWithCreatorNames(items);
    return c.json({ [rcfg.cfg.storageFolder]: enriched });
  };
}

function makeCreateHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const orgSlug = c.get("orgSlug");
    const user = c.get("user");

    // JSON body create path: { manifest, content?, source? }
    if (rcfg.jsonBodyCreate) {
      const body = await c.req.json<{
        manifest: Record<string, unknown>;
        content?: string;
        sourceCode?: string;
      }>();

      const manifest = body.manifest;
      const content = body.content ?? "";
      const sourceCode = body.sourceCode ?? "";

      // Validate manifest
      const manifestResult = validateManifest(manifest);
      if (!manifestResult.valid) {
        throw new ApiError({
          status: 400,
          code: "invalid_manifest",
          title: "Invalid Manifest",
          detail: manifestResult.errors[0] ?? "Invalid manifest",
        });
      }
      const validatedManifest = manifestResult.manifest;

      if (rcfg.requireContent && !content.trim()) {
        throw invalidRequest("Content cannot be empty", "content");
      }

      if (rcfg.validateContent) {
        const validation = rcfg.validateContent(content);
        if (!validation.valid) {
          throw invalidRequest(validation.errors[0] ?? "Validation failed");
        }
      }

      if (rcfg.sourceFileName && !sourceCode.trim()) {
        throw invalidRequest("Source is required", "sourceCode");
      }

      if (rcfg.validateSource && sourceCode) {
        const validation = rcfg.validateSource(sourceCode);
        if (!validation.valid) {
          throw invalidRequest(validation.errors[0] ?? "Validation failed");
        }
      }

      const packageId = validatedManifest.name;

      const scopeErr = checkScopeMatch(c, packageId);
      if (scopeErr) throw scopeErr;

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

      const item = await createOrgItem(
        orgId,
        { id: packageId, content, createdBy: user.id },
        rcfg.cfg,
        validatedManifest as Record<string, unknown>,
      );

      // After-create hook (e.g. auto-enable provider)
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

      // Create initial version (non-fatal)
      await createVersionSafe({
        packageId,
        orgId,
        userId: user.id,
        manifest: validatedManifest,
        normalizedFiles,
      });

      // Auto-install in the current application (non-fatal)
      const appId = c.get("applicationId");
      if (appId) {
        await installPackage(appId, orgId, packageId).catch((e: unknown) =>
          logger.debug("auto-install skipped", { packageId, appId, err: String(e) }),
        );
      }

      return c.json(
        {
          packageId,
          lockVersion: item.lockVersion,
          message: `${rcfg.cfg.label.slice(0, -1)} created`,
        },
        201,
      );
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
        throw new ApiError({
          status: 400,
          code: "invalid_manifest",
          title: "Invalid Manifest",
          detail: manifestResult.errors[0] ?? "Invalid manifest",
        });
      }
    }

    let warnings: string[] = [];
    if (rcfg.validateContent) {
      const validation = rcfg.validateContent(parsed.content);
      if (!validation.valid) {
        throw invalidRequest(validation.errors[0] ?? "Validation failed");
      }
      warnings = validation.warnings;
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
    const appId = c.get("applicationId");
    if (appId) {
      await installPackage(appId, orgId, item.id).catch((e: unknown) =>
        logger.debug("auto-install skipped", { packageId: item.id, appId, err: String(e) }),
      );
    }

    return c.json(
      {
        packageId: item.id,
        lockVersion: item.lockVersion,
        message: `${rcfg.cfg.label.slice(0, -1)} created`,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      201,
    );
  };
}

/** Extract item ID from either `:id` (unscoped) or `:scope/:name` (scoped) route params. */
export function getItemId(c: Context<AppEnv>): string {
  const scope = c.req.param("scope");
  const name = c.req.param("name");
  if (scope && name) return `${scope}/${name}`;
  return c.req.param("id")!;
}

function makeGetHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const [item, versionCount, latestVersionDate] = await Promise.all([
      getOrgItem(orgId, itemId, rcfg.cfg),
      getVersionCount(itemId),
      getLatestVersionCreatedAt(itemId),
    ]);

    if (!item) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }

    // Extract secondary source file from S3 storage (e.g. .ts for tools)
    let sourceText: string | null = null;
    if (rcfg.sourceFileName) {
      const files = await downloadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId);
      const sourceData = files?.[rcfg.sourceFileName(itemId)];
      if (sourceData) {
        sourceText = new TextDecoder().decode(sourceData);
      }
    }

    return c.json({
      [rcfg.responseKey]: {
        ...item,
        ...(sourceText != null ? { sourceCode: sourceText } : {}),
        versionCount,
        hasUnarchivedChanges: computeHasUnpublishedChanges(
          item.source,
          versionCount,
          item.updatedAt ? new Date(item.updatedAt) : null,
          latestVersionDate,
        ),
      },
    });
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

    const body = await c.req.json<{
      manifest?: Record<string, unknown>;
      content?: string;
      sourceCode?: string;
      lockVersion?: number;
    }>();

    if (body.lockVersion == null || typeof body.lockVersion !== "number") {
      throw invalidRequest("lockVersion (integer) is required for updates", "lockVersion");
    }

    const manifest =
      body.manifest ?? (existing as { manifest?: Record<string, unknown> }).manifest ?? {};
    const content = body.content ?? existing.content ?? "";
    const sourceCode = body.sourceCode;

    // Validate manifest
    const manifestResult = validateManifest(manifest);
    if (!manifestResult.valid) {
      throw new ApiError({
        status: 400,
        code: "invalid_manifest",
        title: "Invalid Manifest",
        detail: manifestResult.errors[0] ?? "Invalid manifest",
      });
    }

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
    let warnings: string[] = [];
    if (rcfg.validateContent && content) {
      const validation = rcfg.validateContent(content);
      if (!validation.valid) {
        throw invalidRequest(validation.errors[0] ?? "Validation failed");
      }
      warnings = validation.warnings;
    }

    // Source validation (tools)
    if (rcfg.sourceFileName && sourceCode !== undefined) {
      if (!sourceCode.trim()) {
        throw invalidRequest("Source cannot be empty", "sourceCode");
      }
      if (rcfg.validateSource) {
        const validation = rcfg.validateSource(sourceCode);
        if (!validation.valid) {
          throw invalidRequest(validation.errors[0] ?? "Validation failed");
        }
      }
    }

    const updated = await updateOrgItem(
      orgId,
      itemId,
      { manifest: manifest as Record<string, unknown>, content },
      body.lockVersion,
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

    return c.json({
      packageId: updated.id,
      lockVersion: updated.lockVersion,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  };
}

function makeDeleteHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${label} '${itemId}' is a system package and cannot be deleted`);
    }

    // For agents, check running runs
    if (rcfg.requireMutableForVersionOps) {
      const running = await getRunningRunsForPackage(itemId, orgId);
      if (running > 0) {
        throw conflict(
          "agent_in_use",
          `${running} run(s) still running for this ${label.toLowerCase()}`,
        );
      }
    }

    const result = await deleteOrgItem(orgId, itemId, rcfg.cfg);
    if (!result.ok) {
      throw conflict(
        "in_use",
        `${label} '${itemId}' is used by ${result.dependents!.length} package(s)`,
      );
    }

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

function makeVersionDetailHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const versionQuery = c.req.param("version")!;

    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }

    const detail = await getVersionDetail(itemId, versionQuery);
    if (!detail) {
      throw notFound(`Version '${versionQuery}' not found`);
    }

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

    return c.json({
      id: detail.id,
      version: detail.version,
      manifest: detail.manifest,
      content,
      ...(sourceText != null ? { sourceCode: sourceText } : {}),
      yanked: detail.yanked,
      yankedReason: detail.yankedReason,
      integrity: detail.integrity,
      artifactSize: detail.artifactSize,
      createdAt: detail.createdAt,
      distTags: matchingTags,
    });
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

    // Mutable check: no running runs for agents
    if (rcfg.requireMutableForVersionOps) {
      const running = await getRunningRunsForPackage(itemId, orgId);
      if (running > 0) {
        throw conflict(
          "agent_in_use",
          `${running} run(s) still running for this ${label.toLowerCase()}`,
        );
      }
    }

    const item = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!item) {
      throw notFound(`${label} '${itemId}' not found`);
    }

    // Parse optional version override from request body
    let versionOverride: string | undefined;
    try {
      const body = await c.req.json();
      if (body?.version && typeof body.version === "string") {
        versionOverride = body.version;
      }
    } catch {
      // No body or invalid JSON — proceed without override
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
      throw invalidRequest("Failed to create version (invalid or duplicate)");
    }

    return c.json(
      { id: result.id, version: result.version, message: `Version ${result.version} created` },
      201,
    );
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

    // Mutable check: no running runs for agents
    if (rcfg.requireMutableForVersionOps) {
      const running = await getRunningRunsForPackage(itemId, orgId);
      if (running > 0) {
        throw conflict(
          "agent_in_use",
          `${running} run(s) still running for this ${label.toLowerCase()}`,
        );
      }
    }

    const versionQuery = c.req.param("version")!;
    const detail = await getVersionDetail(itemId, versionQuery);
    if (!detail) {
      throw notFound(`Version '${versionQuery}' not found`);
    }

    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing || !existing.lockVersion) {
      throw notFound(`${label} '${itemId}' not found`);
    }

    // Extract content from version ZIP
    let content = detail.textContent ?? "";
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
      existing.lockVersion,
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

    return c.json({
      message: `Version ${detail.version} restored`,
      restoredVersion: detail.version,
      lockVersion: updated.lockVersion,
    });
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

    if (rcfg.requireMutableForVersionOps) {
      const running = await getRunningRunsForPackage(itemId, orgId);
      if (running > 0) {
        throw conflict(
          "agent_in_use",
          `${running} run(s) still running for this ${label.toLowerCase()}`,
        );
      }
    }

    const versionQuery = c.req.param("version")!;
    const deleted = await deletePackageVersion(itemId, versionQuery);
    if (!deleted) {
      throw notFound(`Version '${versionQuery}' not found`);
    }

    return c.body(null, 204);
  };
}

// ═══════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════

export function createPackagesRouter() {
  const router = new Hono<AppEnv>();

  // --- Package CRUD routes (skills, tools, agents, providers) ---
  for (const rcfg of Object.values(ROUTE_CONFIGS)) {
    const { path } = rcfg;
    // Permission resource matches the route path (e.g. "skills", "tools", "agents", "providers")
    const resource = path as import("../lib/permissions.ts").Resource;
    const writeGuard = requirePermission(resource, "write");
    const deleteGuard = requirePermission(resource, "delete");

    router.get(`/${path}`, makeListHandler(rcfg));
    router.post(`/${path}`, writeGuard, makeCreateHandler(rcfg));
    // Version routes — must be registered before generic get to avoid conflict
    router.get(`/${path}/:scope{@[^/]+}/:name/versions`, makeListVersionsHandler(rcfg));
    // Version info + create version + restore — BEFORE :version param to avoid matching
    router.get(`/${path}/:scope{@[^/]+}/:name/versions/info`, makeVersionInfoHandler(rcfg));
    router.post(
      `/${path}/:scope{@[^/]+}/:name/versions`,
      requireOwnedPackage(),
      writeGuard,
      makeCreateVersionHandler(rcfg),
    );
    router.post(
      `/${path}/:scope{@[^/]+}/:name/versions/:version/restore`,
      requireOwnedPackage(),
      writeGuard,
      makeRestoreVersionHandler(rcfg),
    );
    router.delete(
      `/${path}/:scope{@[^/]+}/:name/versions/:version`,
      requireOwnedPackage(),
      deleteGuard,
      makeDeleteVersionHandler(rcfg),
    );
    router.get(`/${path}/:scope{@[^/]+}/:name/versions/:version`, makeVersionDetailHandler(rcfg));
    // Scoped IDs (@scope/name) — must be registered before unscoped to match first
    router.get(`/${path}/:scope{@[^/]+}/:name`, rcfg.getHandler ?? makeGetHandler(rcfg));
    router.put(
      `/${path}/:scope{@[^/]+}/:name`,
      requireOwnedPackage(),
      writeGuard,
      makeUpdateHandler(rcfg),
    );
    router.delete(
      `/${path}/:scope{@[^/]+}/:name`,
      requireOrgPackage(),
      deleteGuard,
      makeDeleteHandler(rcfg),
    );
    // Unscoped IDs
    router.get(`/${path}/:id`, rcfg.getHandler ?? makeGetHandler(rcfg));
    router.put(`/${path}/:id`, requireOwnedPackage(), writeGuard, makeUpdateHandler(rcfg));
    router.delete(`/${path}/:id`, requireOrgPackage(), deleteGuard, makeDeleteHandler(rcfg));
  }

  // --- Fork route ---
  router.post("/:scope{@[^/]+}/:name/fork", requirePermission("agents", "write"), async (c) => {
    const packageId = getItemId(c);
    const orgId = c.get("orgId");
    const orgSlug = c.get("orgSlug");
    const user = c.get("user");

    const rawBody = await c.req.json().catch(() => ({}));
    const parsed = forkSchema.parse(rawBody);
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

    return c.json(result, 201);
  });

  // --- Provider versions (standalone — providers use their own CRUD in routes/providers.ts) ---
  router.get("/providers/:scope{@[^/]+}/:name/versions", async (c) => {
    const packageId = getItemId(c);
    const versions = await listPackageVersions(packageId);
    return c.json({ versions });
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
  ) {
    const user = c.get("user");
    const orgId = c.get("orgId");
    const { manifest, content, files, type: packageType } = parsed;
    const packageId = manifest.name as string;

    // System packages are immutable
    if (isSystemPackage(packageId)) {
      throw new ApiError({
        status: 400,
        code: "name_collision",
        title: "Name Collision",
        detail: `'${packageId}' is a system package and cannot be overwritten`,
      });
    }

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
      const message = err instanceof Error ? err.message : String(err);
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
    const appId = c.get("applicationId");
    if (appId) {
      await installPackage(appId, orgId, packageId).catch((e: unknown) =>
        logger.debug("auto-install skipped", { packageId, appId, err: String(e) }),
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
    return c.json({ packageId, type: packageType }, 201);
  }

  // POST /api/packages/import — import any package type from ZIP
  router.post("/import", rateLimit(10), requirePermission("agents", "write"), async (c) => {
    const formData = await c.req.formData();
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

    return handleImport(c, parsed, buffer, c.req.query("force") === "true");
  });

  // POST /api/packages/import-github — import a package from a GitHub URL
  router.post("/import-github", rateLimit(10), requirePermission("agents", "write"), async (c) => {
    const body = await c.req.json();
    const data = parseBody(githubImportSchema, body, "url");

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

    return handleImport(c, parsed, buffer, false);
  });

  // GET /api/packages/:scope/:name/:version/download — download a versioned package ZIP
  router.get("/:scope{@[^/]+}/:name/:version/download", rateLimit(50), async (c) => {
    const packageId = getItemId(c);
    const orgId = c.get("orgId");
    const versionQuery = c.req.param("version")!;

    // Verify org ownership (or system package)
    const [pkg] = await db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId)))
      .limit(1);
    if (!pkg) {
      throw notFound("Package not found");
    }

    const ver = await getVersionForDownload(packageId, versionQuery);
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
