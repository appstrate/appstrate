import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { parsePackageZip, PackageZipError } from "@appstrate/core/zip";
import { buildDownloadHeaders } from "@appstrate/core/download";
import { eq, inArray } from "drizzle-orm";
import { packages, profiles } from "@appstrate/db/schema";
import { db } from "../lib/db.ts";
import { postInstallPackage } from "../services/post-install-package.ts";
import { getAllPackageIds } from "../services/flow-service.ts";
import { isSystemPackage } from "../services/system-packages.ts";
import { publishPackage, PublishValidationError } from "../services/registry-publish.ts";
import { getPublishPlan } from "../services/dependency-graph.ts";
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
  syncFlowDepsJunctionTable,
  SKILL_CONFIG,
  EXTENSION_CONFIG,
  FLOW_CONFIG,
  PROVIDER_CONFIG,
  type PackageTypeConfig,
} from "../services/package-items.ts";
import { validateExtensionSource, validateManifest } from "@appstrate/core/validation";
import type { Manifest } from "@appstrate/core/validation";
import { parseScopedName } from "@appstrate/core/naming";
import { unzipAndNormalize } from "../services/package-storage.ts";
import { isValidVersion } from "@appstrate/core/semver";
import {
  getVersionDetail,
  getVersionCount,
  getMatchingDistTags,
  listPackageVersions,
  getVersionInfo,
  getLatestVersionCreatedAt,
  createVersionFromDraft,
  createVersionAndUpload,
  deletePackageVersion,
} from "../services/package-versions.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireAdmin, requireOwnedPackage } from "../middleware/guards.ts";
import { getRunningExecutionsForPackage } from "../services/state.ts";
import { logger } from "../lib/logger.ts";
import { extractDepsFromManifest } from "../lib/manifest-utils.ts";

// ═══════════════════════════════════════════════
// Shared helpers for package CRUD routes
// ═══════════════════════════════════════════════

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

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
 * Returns parsed data or a 400 Response on validation error.
 */
async function parsePackageUpload(
  c: Context<AppEnv>,
  opts: {
    /** Required file inside the ZIP (e.g. "SKILL.md") — null to skip check */
    requiredFile: string | null;
    /** Find the content file by extension (e.g. ".ts") — null to use requiredFile */
    contentFileExt: string | null;
  },
): Promise<ParsedUpload | Response> {
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return c.json({ error: "VALIDATION_ERROR", message: "File is required" }, 400);
    }

    if (!file.name.endsWith(".zip")) {
      return c.json({ error: "VALIDATION_ERROR", message: "Only .zip files are accepted" }, 400);
    }

    const id = file.name.replace(/\.zip$/i, "");
    if (!SLUG_RE.test(id)) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Invalid file name (kebab-case slug required)" },
        400,
      );
    }

    let normalizedFiles: Record<string, Uint8Array>;
    try {
      normalizedFiles = unzipAndNormalize(Buffer.from(await file.arrayBuffer()));
    } catch {
      return c.json({ error: "VALIDATION_ERROR", message: "Invalid ZIP file" }, 400);
    }

    // Find the content file
    let contentFile: string | undefined;
    if (opts.requiredFile) {
      if (!normalizedFiles[opts.requiredFile]) {
        return c.json(
          { error: "VALIDATION_ERROR", message: `ZIP must contain ${opts.requiredFile}` },
          400,
        );
      }
      contentFile = opts.requiredFile;
    }
    if (opts.contentFileExt) {
      contentFile = Object.keys(normalizedFiles).find((p) => p.endsWith(opts.contentFileExt!));
      if (!contentFile) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: `ZIP must contain a ${opts.contentFileExt} file`,
          },
          400,
        );
      }
    }

    const content = new TextDecoder().decode(normalizedFiles[contentFile!]!);

    let name: string | undefined;
    let description: string | undefined;

    // Parse manifest.json from ZIP if present — store as-is (like the registry)
    let manifest: Record<string, unknown> | undefined;
    const manifestBytes = normalizedFiles["manifest.json"];
    if (manifestBytes) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
        if (typeof parsed === "object" && parsed !== null) {
          manifest = parsed as Record<string, unknown>;
          // Extract display fields as fallbacks (not for manifest storage)
          if (!name && typeof parsed.displayName === "string") name = parsed.displayName;
          if (!description && typeof parsed.description === "string")
            description = parsed.description;
        }
      } catch {
        // Ignore invalid manifest.json — not required for package uploads
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
    return c.json({ error: "VALIDATION_ERROR", message: "id and content are required" }, 400);
  }

  if (!SLUG_RE.test(body.id)) {
    return c.json(
      { error: "VALIDATION_ERROR", message: "Invalid id (kebab-case slug required)" },
      400,
    );
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
    const { zipArtifact } = await import("@appstrate/core/zip");
    const entries: Record<string, Uint8Array> = { ...params.normalizedFiles };
    entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(params.manifest, null, 2));
    const zipBuffer = Buffer.from(zipArtifact(entries, 6));

    await createVersionAndUpload({
      packageId: params.packageId,
      version,
      orgId: params.orgId,
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
  parseOpts: {
    requiredFile: string | null;
    contentFileExt: string | null;
  };
  responseKey: string;
  validateContent?: (content: string) => { valid: boolean; errors: string[]; warnings: string[] };
  storageFileName: (id: string) => string;
  /** Hook called after a new package is created. */
  afterCreate?: (params: {
    packageId: string;
    orgId: string;
    manifest: Record<string, unknown>;
  }) => Promise<void>;
  /** Hook called after a package is updated. */
  afterUpdate?: (params: {
    packageId: string;
    orgId: string;
    manifest: Record<string, unknown>;
  }) => Promise<void>;
  /** If true, version create/restore require no running executions (flows). */
  requireMutableForVersionOps?: boolean;
  /** If true, this type uses JSON body for create (not ZIP upload parsing). */
  jsonBodyCreate?: boolean;
}

const ROUTE_CONFIGS: Record<string, PackageRouteConfig> = {
  skills: {
    cfg: SKILL_CONFIG,
    parseOpts: { requiredFile: "SKILL.md", contentFileExt: null },
    responseKey: "skill",
    storageFileName: () => "SKILL.md",
  },
  extensions: {
    cfg: EXTENSION_CONFIG,
    parseOpts: { requiredFile: null, contentFileExt: ".ts" },
    responseKey: "extension",
    validateContent: validateExtensionSource,
    storageFileName: (id) => `${parseScopedName(id)?.name ?? id}.ts`,
  },
  flows: {
    cfg: FLOW_CONFIG,
    parseOpts: { requiredFile: null, contentFileExt: null },
    responseKey: "flow",
    storageFileName: () => "prompt.md",
    jsonBodyCreate: true,
    requireMutableForVersionOps: true,
    afterCreate: async ({ packageId, orgId, manifest }) => {
      const { skillIds, extensionIds, providerIds } = extractDepsFromManifest(
        manifest as Partial<Manifest>,
      );
      await syncFlowDepsJunctionTable(packageId, orgId, skillIds, extensionIds, providerIds);
    },
    afterUpdate: async ({ packageId, orgId, manifest }) => {
      const { skillIds, extensionIds, providerIds } = extractDepsFromManifest(
        manifest as Partial<Manifest>,
      );
      await syncFlowDepsJunctionTable(packageId, orgId, skillIds, extensionIds, providerIds);
    },
  },
  providers: {
    cfg: PROVIDER_CONFIG,
    parseOpts: { requiredFile: null, contentFileExt: null },
    responseKey: "provider",
    storageFileName: () => "definition.json",
    jsonBodyCreate: true,
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

    // Flow create uses JSON body with { manifest, content }
    if (rcfg.jsonBodyCreate) {
      const body = await c.req.json<{
        manifest: Record<string, unknown>;
        content?: string;
      }>();

      const manifest = body.manifest;
      const content = body.content ?? "";

      // Validate manifest
      const manifestResult = validateManifest(manifest);
      if (!manifestResult.valid) {
        return c.json(
          {
            error: "INVALID_MANIFEST",
            message: "Invalid manifest",
            details: manifestResult.errors,
          },
          400,
        );
      }
      const validatedManifest = manifestResult.manifest;

      if (!content.trim()) {
        return c.json({ error: "VALIDATION_ERROR", message: "Content cannot be empty" }, 400);
      }

      const packageId = validatedManifest.name;

      // Check for name collision
      const existingIds = await getAllPackageIds(orgId);
      if (existingIds.includes(packageId)) {
        return c.json(
          {
            error: "NAME_COLLISION",
            message: `A ${rcfg.cfg.type} with identifier '${packageId}' already exists`,
          },
          400,
        );
      }

      // Insert into DB
      const item = await createOrgItem(
        orgId,
        null, // packageId is already fully scoped from manifest.name
        {
          id: packageId,
          content,
          createdBy: user.id,
        },
        rcfg.cfg,
        validatedManifest as Record<string, unknown>,
      );

      // After-create hook (e.g. flow junction table sync)
      if (rcfg.afterCreate) {
        await rcfg.afterCreate({ packageId, orgId, manifest: validatedManifest });
      }

      // Create initial version (non-fatal)
      const contentFileName = rcfg.storageFileName(packageId);
      await createVersionSafe({
        packageId,
        orgId,
        userId: user.id,
        manifest: validatedManifest,
        normalizedFiles: { [contentFileName]: new TextEncoder().encode(content) },
      });

      return c.json(
        {
          packageId,
          lockVersion: item.version,
          message: `${rcfg.cfg.label.slice(0, -1)} created`,
        },
        201,
      );
    }

    // Skill/Extension create — uses parsePackageUpload (ZIP or JSON body)
    const parsed = await parsePackageUpload(c, rcfg.parseOpts);
    if (parsed instanceof Response) return parsed;

    if (isSystemPackage(parsed.id)) {
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `${rcfg.cfg.label.slice(0, -1)} '${parsed.id}' is a system package and cannot be modified`,
        },
        403,
      );
    }

    // Validate manifest if present
    if (parsed.manifest) {
      const manifestResult = validateManifest(parsed.manifest);
      if (!manifestResult.valid) {
        return c.json(
          {
            error: "INVALID_MANIFEST",
            message: "Invalid manifest",
            details: manifestResult.errors,
          },
          400,
        );
      }
    }

    let warnings: string[] = [];
    if (rcfg.validateContent) {
      const validation = rcfg.validateContent(parsed.content);
      if (!validation.valid) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: validation.errors[0],
            details: validation.errors,
            warnings: validation.warnings,
          },
          400,
        );
      }
      warnings = validation.warnings;
    }

    // Merge user-specified version into manifest for createOrgItem
    const effectiveManifest = parsed.manifest
      ? parsed.manifest
      : parsed.version
        ? { version: parsed.version }
        : undefined;

    const item = await createOrgItem(
      orgId,
      orgSlug,
      {
        id: parsed.id,
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        createdBy: user.id,
      },
      rcfg.cfg,
      effectiveManifest,
    );

    if (parsed.normalizedFiles) {
      await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, item.id, parsed.normalizedFiles);
    }

    // After-create hook
    if (rcfg.afterCreate) {
      const finalManifest = (item.manifest ?? {}) as Record<string, unknown>;
      await rcfg.afterCreate({ packageId: item.id, orgId, manifest: finalManifest });
    }

    // Create initial version (non-fatal)
    const finalManifest = (item.manifest ?? {}) as Record<string, unknown>;
    await createVersionSafe({
      packageId: item.id,
      orgId,
      userId: user.id,
      manifest: finalManifest,
      normalizedFiles: parsed.normalizedFiles ?? {},
    });

    return c.json(
      {
        [rcfg.responseKey]: {
          id: item.id,
          name: item.name,
          description: ((item.manifest ?? {}) as Partial<Manifest>).description ?? null,
        },
        lockVersion: item.version,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      201,
    );
  };
}

/** Extract item ID from either `:id` (unscoped) or `:scope/:name` (scoped) route params. */
function getItemId(c: Context<AppEnv>): string {
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
      return c.json(
        {
          error: "NOT_FOUND",
          message: `${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`,
        },
        404,
      );
    }

    const hasUnpublishedChanges =
      item.source === "local"
        ? versionCount === 0
          ? true // No versions yet — entire package is unpublished
          : latestVersionDate
            ? new Date(item.updatedAt ?? Date.now()) > latestVersionDate
            : false
        : false;

    return c.json({
      [rcfg.responseKey]: {
        ...item,
        versionCount,
        hasUnpublishedChanges,
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
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `${label} '${itemId}' is a system package and cannot be modified`,
        },
        403,
      );
    }

    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing) {
      return c.json({ error: "NOT_FOUND", message: `${label} '${itemId}' not found` }, 404);
    }

    const body = await c.req.json<{
      manifest?: Record<string, unknown>;
      content?: string;
      lockVersion?: number;
    }>();

    if (body.lockVersion == null || typeof body.lockVersion !== "number") {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "lockVersion (integer) is required for updates",
        },
        400,
      );
    }

    const manifest =
      body.manifest ?? (existing as { manifest?: Record<string, unknown> }).manifest ?? {};
    const content = body.content ?? existing.content ?? "";

    // Validate manifest
    const manifestResult = validateManifest(manifest);
    if (!manifestResult.valid) {
      return c.json(
        {
          error: "INVALID_MANIFEST",
          message: "Invalid manifest",
          details: manifestResult.errors,
        },
        400,
      );
    }

    // Ensure ID immutability (all types)
    const newScopedName = (manifest as { name?: string }).name;
    if (newScopedName && newScopedName !== itemId) {
      return c.json({ error: "VALIDATION_ERROR", message: "name cannot change" }, 400);
    }

    // Content cannot be empty (all types)
    if (!content.trim()) {
      return c.json({ error: "VALIDATION_ERROR", message: "Content cannot be empty" }, 400);
    }

    // Content validation (extensions)
    let warnings: string[] = [];
    if (rcfg.validateContent && content) {
      const validation = rcfg.validateContent(content);
      if (!validation.valid) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: validation.errors[0],
            details: validation.errors,
            warnings: validation.warnings,
          },
          400,
        );
      }
      warnings = validation.warnings;
    }

    const updated = await updateOrgItem(
      itemId,
      { manifest: manifest as Record<string, unknown>, content },
      body.lockVersion,
    );

    if (!updated) {
      return c.json(
        {
          error: "CONFLICT",
          message: `${label} was modified concurrently. Reload and try again.`,
        },
        409,
      );
    }

    // Update storage files
    await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId, {
      [rcfg.storageFileName(itemId)]: new TextEncoder().encode(content),
    });

    // After-update hook (e.g. flow junction table sync)
    if (rcfg.afterUpdate) {
      await rcfg.afterUpdate({
        packageId: itemId,
        orgId,
        manifest: manifest as Record<string, unknown>,
      });
    }

    return c.json({
      [rcfg.responseKey]: {
        id: updated.id,
        name: updated.name,
        description: ((updated.manifest ?? {}) as Partial<Manifest>).description ?? null,
      },
      lockVersion: updated.version,
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
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `${label} '${itemId}' is a system package and cannot be deleted`,
        },
        403,
      );
    }

    // For flows, check running executions
    if (rcfg.requireMutableForVersionOps) {
      const running = await getRunningExecutionsForPackage(itemId);
      if (running > 0) {
        return c.json(
          {
            error: "FLOW_IN_USE",
            message: `${running} execution(s) running for this ${label.toLowerCase()}`,
          },
          409,
        );
      }
    }

    const result = await deleteOrgItem(orgId, itemId, rcfg.cfg);
    if (!result.ok) {
      if (result.error === "DEPENDED_ON") {
        return c.json(
          {
            error: "DEPENDED_ON",
            message: `${label} '${itemId}' is required by ${result.dependents!.length} marketplace package(s)`,
            dependents: result.dependents,
          },
          409,
        );
      }
      return c.json(
        {
          error: "IN_USE",
          message: `${label} '${itemId}' is used by ${result.flows!.length} flow(s)`,
          flows: result.flows,
        },
        409,
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
      return c.json(
        { error: "NOT_FOUND", message: `${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found` },
        404,
      );
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
      return c.json(
        { error: "NOT_FOUND", message: `${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found` },
        404,
      );
    }

    const detail = await getVersionDetail(itemId, versionQuery);
    if (!detail) {
      return c.json(
        { error: "VERSION_NOT_FOUND", message: `Version '${versionQuery}' not found` },
        404,
      );
    }

    const matchingTags = await getMatchingDistTags(itemId, detail.version);

    // Extract primary content file from the ZIP
    let content: string | null = null;
    if (detail.content) {
      const fileName = rcfg.storageFileName(itemId);
      const fileData = detail.content[fileName];
      if (fileData) {
        content = new TextDecoder().decode(fileData);
      }
    }

    return c.json({
      id: detail.id,
      version: detail.version,
      manifest: detail.manifest,
      content,
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
      return c.json(
        { error: "NOT_FOUND", message: `${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found` },
        404,
      );
    }
    const info = await getVersionInfo(itemId);
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
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: `${label} '${itemId}' is a system package` },
        403,
      );
    }

    // Mutable check: no running executions for flows
    if (rcfg.requireMutableForVersionOps) {
      const running = await getRunningExecutionsForPackage(itemId);
      if (running > 0) {
        return c.json(
          {
            error: "FLOW_IN_USE",
            message: `${running} execution(s) running for this ${label.toLowerCase()}`,
          },
          409,
        );
      }
    }

    const item = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!item) {
      return c.json({ error: "NOT_FOUND", message: `${label} '${itemId}' not found` }, 404);
    }

    const result = await createVersionFromDraft({
      packageId: itemId,
      orgId,
      userId: user.id,
    });

    if (!result) {
      return c.json(
        { error: "VERSION_FAILED", message: "Failed to create version (invalid or duplicate)" },
        400,
      );
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
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: `${label} '${itemId}' is a system package` },
        403,
      );
    }

    // Mutable check: no running executions for flows
    if (rcfg.requireMutableForVersionOps) {
      const running = await getRunningExecutionsForPackage(itemId);
      if (running > 0) {
        return c.json(
          {
            error: "FLOW_IN_USE",
            message: `${running} execution(s) running for this ${label.toLowerCase()}`,
          },
          409,
        );
      }
    }

    const versionQuery = c.req.param("version")!;
    const detail = await getVersionDetail(itemId, versionQuery);
    if (!detail) {
      return c.json(
        { error: "VERSION_NOT_FOUND", message: `Version '${versionQuery}' not found` },
        404,
      );
    }

    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing || !existing.lockVersion) {
      return c.json({ error: "NOT_FOUND", message: `${label} '${itemId}' not found` }, 404);
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
      itemId,
      { manifest: detail.manifest, content },
      existing.lockVersion,
    );

    if (!updated) {
      return c.json(
        { error: "CONFLICT", message: "Package was modified concurrently. Reload and try again." },
        409,
      );
    }

    // If restoring the latest version, align updatedAt so the draft
    // doesn't appear as having unpublished changes.
    const latestDate = await getLatestVersionCreatedAt(itemId);
    if (
      latestDate &&
      detail.createdAt &&
      new Date(detail.createdAt).getTime() === latestDate.getTime()
    ) {
      await db.update(packages).set({ updatedAt: latestDate }).where(eq(packages.id, itemId));
    }

    // Re-upload storage files from the version ZIP
    if (detail.content) {
      await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId, detail.content);
    }

    // After-update hook (e.g. flow junction table sync on restore)
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
      lockVersion: updated.version,
    });
  };
}

function makeDeleteVersionHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: `${label} '${itemId}' is a system package` },
        403,
      );
    }

    if (rcfg.requireMutableForVersionOps) {
      const running = await getRunningExecutionsForPackage(itemId);
      if (running > 0) {
        return c.json(
          {
            error: "FLOW_IN_USE",
            message: `${running} execution(s) running for this ${label.toLowerCase()}`,
          },
          409,
        );
      }
    }

    const versionQuery = c.req.param("version")!;
    const deleted = await deletePackageVersion(itemId, versionQuery);
    if (!deleted) {
      return c.json(
        { error: "VERSION_NOT_FOUND", message: `Version '${versionQuery}' not found` },
        404,
      );
    }

    return c.body(null, 204);
  };
}

// ═══════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════

export function createPackagesRouter() {
  const router = new Hono<AppEnv>();

  // --- Package CRUD routes (skills, extensions, flows) ---
  for (const [path, rcfg] of Object.entries(ROUTE_CONFIGS)) {
    router.get(`/${path}`, makeListHandler(rcfg));
    router.post(`/${path}`, requireAdmin(), makeCreateHandler(rcfg));
    // Version routes — must be registered before generic get to avoid conflict
    router.get(`/${path}/:scope{@[^/]+}/:name/versions`, makeListVersionsHandler(rcfg));
    // Version info + create version + restore — BEFORE :version param to avoid matching
    router.get(`/${path}/:scope{@[^/]+}/:name/versions/info`, makeVersionInfoHandler(rcfg));
    router.post(
      `/${path}/:scope{@[^/]+}/:name/versions`,
      requireAdmin(),
      requireOwnedPackage(),
      makeCreateVersionHandler(rcfg),
    );
    router.post(
      `/${path}/:scope{@[^/]+}/:name/versions/:version/restore`,
      requireAdmin(),
      requireOwnedPackage(),
      makeRestoreVersionHandler(rcfg),
    );
    router.delete(
      `/${path}/:scope{@[^/]+}/:name/versions/:version`,
      requireAdmin(),
      requireOwnedPackage(),
      makeDeleteVersionHandler(rcfg),
    );
    router.get(`/${path}/:scope{@[^/]+}/:name/versions/:version`, makeVersionDetailHandler(rcfg));
    // Scoped IDs (@scope/name) — must be registered before unscoped to match first
    router.get(`/${path}/:scope{@[^/]+}/:name`, makeGetHandler(rcfg));
    router.put(
      `/${path}/:scope{@[^/]+}/:name`,
      requireAdmin(),
      requireOwnedPackage(),
      makeUpdateHandler(rcfg),
    );
    router.delete(
      `/${path}/:scope{@[^/]+}/:name`,
      requireAdmin(),
      requireOwnedPackage(),
      makeDeleteHandler(rcfg),
    );
    // Unscoped IDs
    router.get(`/${path}/:id`, makeGetHandler(rcfg));
    router.put(`/${path}/:id`, requireAdmin(), requireOwnedPackage(), makeUpdateHandler(rcfg));
    router.delete(`/${path}/:id`, requireAdmin(), requireOwnedPackage(), makeDeleteHandler(rcfg));
  }

  // --- Fork route ---
  router.post("/:scope{@[^/]+}/:name/fork", requireAdmin(), async (c) => {
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    const orgId = c.get("orgId");
    const orgSlug = c.get("orgSlug");
    const user = c.get("user");

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const customName = typeof body.name === "string" ? body.name : undefined;

    if (customName !== undefined) {
      const { SLUG_REGEX } = await import("@appstrate/core/naming");
      if (!SLUG_REGEX.test(customName)) {
        return c.json({ error: "INVALID_NAME", message: "Name must match slug format" }, 400);
      }
    }

    const { forkPackage } = await import("../services/package-fork.ts");
    const result = await forkPackage(orgId, orgSlug, packageId, user.id, customName);

    if ("code" in result) {
      switch (result.code) {
        case "ALREADY_OWNED":
          return c.json({ error: "ALREADY_OWNED", message: "You already own this package" }, 400);
        case "NOT_FOUND":
          return c.json({ error: "NOT_FOUND", message: "Package not found" }, 404);
        case "NAME_COLLISION":
          return c.json(
            {
              error: "NAME_COLLISION",
              message: "A package with this name already exists in your organization",
            },
            400,
          );
        case "UNKNOWN_TYPE":
          return c.json(
            { error: "UNKNOWN_TYPE", message: `Unsupported package type: ${result.type}` },
            400,
          );
      }
    }

    return c.json(result, 201);
  });

  // --- Provider versions (standalone — providers use their own CRUD in routes/providers.ts) ---
  router.get("/providers/:scope{@[^/]+}/:name/versions", async (c) => {
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    const versions = await listPackageVersions(packageId);
    return c.json({ versions });
  });

  // --- Package import/download/publish routes ---

  // POST /api/packages/import — import any package type from ZIP
  router.post("/import", rateLimit(10), requireAdmin(), async (c) => {
    const user = c.get("user");
    const orgId = c.get("orgId");

    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return c.json({ error: "VALIDATION_ERROR", message: "No file provided" }, 400);
    }
    if (!file.name.endsWith(".zip")) {
      return c.json({ error: "VALIDATION_ERROR", message: "Only .zip files are accepted" }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let parsed;
    try {
      parsed = parsePackageZip(new Uint8Array(buffer));
    } catch (err) {
      if (err instanceof PackageZipError) {
        return c.json({ error: err.code, message: err.message, details: err.details }, 400);
      }
      throw err;
    }

    const { manifest, content, files, type: packageType } = parsed;
    const packageId = manifest.name as string;

    // System packages are immutable
    if (isSystemPackage(packageId)) {
      return c.json(
        {
          error: "NAME_COLLISION",
          message: `'${packageId}' is a system package and cannot be overwritten`,
        },
        400,
      );
    }

    // Check for existing user package
    const existing = await getPackageById(packageId);
    const force = c.req.query("force") === "true";

    if (existing) {
      if (existing.orgId !== orgId) {
        return c.json(
          {
            error: "NAME_COLLISION",
            message: `A package with identifier '${packageId}' already exists`,
          },
          400,
        );
      }
      if (existing.type !== packageType) {
        return c.json(
          {
            error: "TYPE_MISMATCH",
            message: `Package '${packageId}' exists as type '${existing.type}', cannot import as '${packageType}'`,
          },
          400,
        );
      }
      // Draft overwrite protection
      if (!force) {
        const [vCount, latestDate] = await Promise.all([
          getVersionCount(packageId),
          getLatestVersionCreatedAt(packageId),
        ]);
        const hasUnpublishedChanges =
          existing.source === "local" && vCount > 0 && latestDate
            ? (existing.updatedAt ?? new Date()) > latestDate
            : false;
        if (hasUnpublishedChanges) {
          return c.json(
            {
              error: "DRAFT_OVERWRITE",
              message:
                "Ce package a des modifications non publiées qui seront écrasées par l'import.",
              details: {
                packageId,
                draftVersion: (existing.manifest as Record<string, unknown>)?.version ?? null,
              },
            },
            409,
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
            return c.json(
              {
                error: "INTEGRITY_MISMATCH",
                message:
                  "Cette version existe déjà avec un contenu différent. Utilisez l'option force pour remplacer.",
                details: { packageId, version: importedVersion },
              },
              409,
            );
          }
        }
      }

      // Update existing package manifest and content
      await db
        .update(packages)
        .set({ manifest, content, updatedAt: new Date() })
        .where(eq(packages.id, packageId));
    } else {
      // New package — insert (orgSlug=null since packageId is already fully scoped from manifest.name)
      const cfg = ROUTE_CONFIGS[packageType + "s"]?.cfg;
      if (!cfg) {
        return c.json(
          { error: "INVALID_TYPE", message: `Unknown package type '${packageType}'` },
          400,
        );
      }
      await createOrgItem(
        orgId,
        null,
        { id: packageId, content, createdBy: user.id },
        cfg,
        manifest as Record<string, unknown>,
      );
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
      return c.json({ error: "POST_INSTALL_FAILED", message }, 400);
    }

    // Sync flow dependency junction table after import (providers included)
    if (packageType === "flow") {
      const { skillIds, extensionIds, providerIds } = extractDepsFromManifest(
        manifest as Partial<Manifest>,
      );
      await syncFlowDepsJunctionTable(packageId, orgId, skillIds, extensionIds, providerIds);
    }

    // Force import: replace existing version content if integrity differs
    // Runs after postInstallPackage so we don't duplicate the ZIP upload
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
  });

  // GET /api/packages/:scope/:name/:version/download — download a versioned package ZIP
  router.get("/:scope{@[^/]+}/:name/:version/download", rateLimit(50), async (c) => {
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    const versionQuery = c.req.param("version")!;

    const ver = await getVersionForDownload(packageId, versionQuery);
    if (!ver) {
      return c.json({ error: "NOT_FOUND", message: "Version not found" }, 404);
    }

    let data: Buffer | null;
    try {
      data = await downloadVersionZip(packageId, ver.version, ver.integrity);
    } catch {
      return c.json({ error: "INTEGRITY_ERROR", message: "Artifact integrity check failed" }, 500);
    }
    if (!data) {
      return c.json({ error: "NOT_FOUND", message: "Artifact not found in storage" }, 404);
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

  // GET /api/packages/:scope/:name/publish-plan — get publish dependency plan
  router.get("/:scope{@[^/]+}/:name/publish-plan", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    const targetVersion = c.req.query("version") || undefined;
    const plan = await getPublishPlan(packageId, orgId, targetVersion);
    return c.json(plan);
  });

  // POST /api/packages/:scope/:name/publish — publish a package to registry
  router.post("/:scope{@[^/]+}/:name/publish", requireAdmin(), requireOwnedPackage(), async (c) => {
    const user = c.get("user");
    const orgId = c.get("orgId");
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    const body = await c.req.json().catch(() => ({}));
    const targetVersion = body.version as string | undefined;

    try {
      const result = await publishPackage(packageId, orgId, user.id, targetVersion);
      return c.json(result);
    } catch (err) {
      if (err instanceof PublishValidationError) {
        logger.warn("Publish validation error", {
          packageId,
          code: err.code,
          error: err.message,
        });
        return c.json({ error: err.code, message: err.message }, err.statusCode as 400 | 409 | 502);
      }
      const message = err instanceof Error ? err.message : "Failed to publish package";
      logger.error("Publish failed", { packageId, error: message });
      return c.json({ error: "PUBLISH_FAILED", message }, 500);
    }
  });

  return router;
}
