import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { parsePackageZip, PackageZipError } from "@appstrate/core/zip";
import { buildDownloadHeaders } from "@appstrate/core/download";
import { eq, inArray } from "drizzle-orm";
import { packages, profiles } from "@appstrate/db/schema";
import { db } from "../lib/db.ts";
import { getPackageById, insertPackage, updatePackage } from "../services/user-flows.ts";
import { postInstallPackage } from "../services/post-install-package.ts";
import { isBuiltInFlow } from "../services/flow-service.ts";
import { isBuiltInSkill, isBuiltInExtension } from "../services/builtin-packages.ts";
import { publishPackage, PublishValidationError } from "../services/registry-publish.ts";
import { getPublishPlan } from "../services/dependency-graph.ts";
import { getVersionForDownload } from "../services/package-versions.ts";
import { downloadVersionZip } from "../services/package-storage.ts";
import {
  listOrgItems,
  getOrgItem,
  upsertOrgItem,
  deleteOrgItem,
  uploadPackageFiles,
  SKILL_CONFIG,
  EXTENSION_CONFIG,
  type PackageTypeConfig,
} from "../services/package-items.ts";
import { extractSkillMeta, validateExtensionSource } from "@appstrate/core/validation";
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
} from "../services/package-versions.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { logger } from "../lib/logger.ts";

// ═══════════════════════════════════════════════
// Shared helpers for skill/extension CRUD routes
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
    /** Extract metadata from content (skill YAML frontmatter) */
    extractMeta: boolean;
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
    if (opts.extractMeta) {
      const meta = extractSkillMeta(content);
      name = meta.name || undefined;
      description = meta.description || undefined;
    }

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
    name?: string;
    description?: string;
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

  let { name, description } = body;
  if (opts.extractMeta && (!name || !description)) {
    const meta = extractSkillMeta(body.content);
    if (!name) name = meta.name || undefined;
    if (!description) description = meta.description || undefined;
  }

  // Synthesize normalizedFiles so the ZIP is uploaded to storage (same as multipart path)
  const encoded = new TextEncoder().encode(body.content);
  const fileName =
    opts.requiredFile ?? (opts.contentFileExt ? `${body.id}${opts.contentFileExt}` : "content");
  const normalizedFiles: Record<string, Uint8Array> = { [fileName]: encoded };

  return { id: body.id, name, description, content: body.content, normalizedFiles };
}

// --- Route configuration per package type ---

interface PackageRouteConfig {
  cfg: PackageTypeConfig;
  parseOpts: { requiredFile: string | null; contentFileExt: string | null; extractMeta: boolean };
  responseKey: string;
  validateContent?: (content: string) => { valid: boolean; errors: string[]; warnings: string[] };
  storageFileName: (id: string) => string;
}

const ROUTE_CONFIGS: Record<string, PackageRouteConfig> = {
  skills: {
    cfg: SKILL_CONFIG,
    parseOpts: { requiredFile: "SKILL.md", contentFileExt: null, extractMeta: true },
    responseKey: "skill",
    storageFileName: () => "SKILL.md",
  },
  extensions: {
    cfg: EXTENSION_CONFIG,
    parseOpts: { requiredFile: null, contentFileExt: ".ts", extractMeta: false },
    responseKey: "extension",
    validateContent: validateExtensionSource,
    storageFileName: (id) => `${id}.ts`,
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

    const parsed = await parsePackageUpload(c, rcfg.parseOpts);
    if (parsed instanceof Response) return parsed;

    if (rcfg.cfg.isBuiltIn(parsed.id)) {
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `${rcfg.cfg.label.slice(0, -1)} '${parsed.id}' is built-in and cannot be modified`,
        },
        403,
      );
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

    const item = await upsertOrgItem(
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
      parsed.manifest,
    );

    if (parsed.normalizedFiles) {
      await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, parsed.id, parsed.normalizedFiles);
    }

    return c.json(
      {
        [rcfg.responseKey]: {
          id: item.id,
          name: item.name,
          description: ((item.manifest ?? {}) as Partial<Manifest>).description ?? null,
        },
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
      item.source !== "built-in" && versionCount > 0 && latestVersionDate
        ? new Date(item.updatedAt ?? Date.now()) > latestVersionDate
        : false;

    return c.json({ [rcfg.responseKey]: { ...item, versionCount, hasUnpublishedChanges } });
  };
}

function makeUpdateHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (rcfg.cfg.isBuiltIn(itemId)) {
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `${label} '${itemId}' is built-in and cannot be modified`,
        },
        403,
      );
    }

    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing) {
      return c.json({ error: "NOT_FOUND", message: `${label} '${itemId}' not found` }, 404);
    }

    const body = await c.req.json<{
      name?: string;
      description?: string;
      content?: string;
      version?: string;
      scopedName?: string;
    }>();

    if (body.version && !isValidVersion(body.version)) {
      return c.json({ error: "VALIDATION_ERROR", message: "Invalid semver version (X.Y.Z)" }, 400);
    }
    if (body.scopedName && !parseScopedName(body.scopedName)) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Invalid scoped name (@scope/name)" },
        400,
      );
    }

    let warnings: string[] = [];
    if (rcfg.validateContent && body.content) {
      const validation = rcfg.validateContent(body.content);
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

    const finalContent = body.content ?? existing.content;
    const existingManifest = ((existing as { manifest?: Record<string, unknown> }).manifest ??
      {}) as Record<string, unknown>;

    // Merge body overrides into manifest (version, scopedName are manifest fields now)
    const mergedManifest = {
      ...existingManifest,
      ...(body.version && { version: body.version }),
      ...(body.scopedName && { name: body.scopedName }),
    };

    // Pass null for orgSlug — itemId is already the full package ID from the DB,
    // so upsertOrgItem should use it directly instead of reconstructing it.
    const item = await upsertOrgItem(
      orgId,
      null,
      {
        id: itemId,
        name: body.name ?? existing.name ?? undefined,
        description: body.description ?? existing.description ?? undefined,
        content: finalContent!,
        createdBy: existing.createdBy ?? user.id,
      },
      rcfg.cfg,
      mergedManifest,
    );

    // Update storage ZIP so container packaging stays in sync
    await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId, {
      [rcfg.storageFileName(itemId)]: new TextEncoder().encode(finalContent!),
    });

    return c.json({
      [rcfg.responseKey]: {
        id: item.id,
        name: item.name,
        description: ((item.manifest ?? {}) as Partial<Manifest>).description ?? null,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  };
}

function makeDeleteHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (rcfg.cfg.isBuiltIn(itemId)) {
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `${label} '${itemId}' is built-in and cannot be deleted`,
        },
        403,
      );
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
      // For skills, look for SKILL.md; for extensions, look for .ts file
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

    if (rcfg.cfg.isBuiltIn(itemId)) {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: `${label} '${itemId}' is built-in` },
        403,
      );
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

    if (rcfg.cfg.isBuiltIn(itemId)) {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: `${label} '${itemId}' is built-in` },
        403,
      );
    }

    const versionQuery = c.req.param("version")!;
    const detail = await getVersionDetail(itemId, versionQuery);
    if (!detail) {
      return c.json(
        { error: "VERSION_NOT_FOUND", message: `Version '${versionQuery}' not found` },
        404,
      );
    }

    const pkg = await getPackageById(itemId);
    if (!pkg) {
      return c.json({ error: "NOT_FOUND", message: `${label} '${itemId}' not found` }, 404);
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

    const updated = await updatePackage(
      itemId,
      { manifest: detail.manifest, content },
      pkg.version,
    );

    if (!updated) {
      return c.json(
        { error: "CONFLICT", message: "Package was modified concurrently. Reload and try again." },
        409,
      );
    }

    // Align updatedAt with the restored version's timestamp — the draft is now
    // a known version state, not new unpublished work.
    if (detail.createdAt) {
      await db
        .update(packages)
        .set({ updatedAt: new Date(detail.createdAt) })
        .where(eq(packages.id, itemId));
    }

    // Re-upload storage files from the version ZIP
    if (detail.content) {
      await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId, detail.content);
    }

    return c.json({
      message: `Version ${detail.version} restored`,
      restoredVersion: detail.version,
      lockVersion: updated.version,
    });
  };
}

// ═══════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════

export function createPackagesRouter() {
  const router = new Hono<AppEnv>();

  // --- Skill/Extension CRUD routes ---
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
      makeCreateVersionHandler(rcfg),
    );
    router.post(
      `/${path}/:scope{@[^/]+}/:name/versions/:version/restore`,
      requireAdmin(),
      makeRestoreVersionHandler(rcfg),
    );
    router.get(`/${path}/:scope{@[^/]+}/:name/versions/:version`, makeVersionDetailHandler(rcfg));
    // Scoped IDs (@scope/name) — must be registered before unscoped to match first
    router.get(`/${path}/:scope{@[^/]+}/:name`, makeGetHandler(rcfg));
    router.put(`/${path}/:scope{@[^/]+}/:name`, requireAdmin(), makeUpdateHandler(rcfg));
    router.delete(`/${path}/:scope{@[^/]+}/:name`, requireAdmin(), makeDeleteHandler(rcfg));
    // Unscoped IDs
    router.get(`/${path}/:id`, makeGetHandler(rcfg));
    router.put(`/${path}/:id`, requireAdmin(), makeUpdateHandler(rcfg));
    router.delete(`/${path}/:id`, requireAdmin(), makeDeleteHandler(rcfg));
  }

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

    // Built-in packages are immutable
    const isBuiltIn =
      isBuiltInFlow(packageId) || isBuiltInSkill(packageId) || isBuiltInExtension(packageId);
    if (isBuiltIn) {
      return c.json(
        {
          error: "NAME_COLLISION",
          message: `'${packageId}' is a built-in package and cannot be overwritten`,
        },
        400,
      );
    }

    // Check for existing user package
    const existing = await getPackageById(packageId);

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
      // Update existing package manifest and content
      await db
        .update(packages)
        .set({ manifest, content, updatedAt: new Date() })
        .where(eq(packages.id, packageId));
    } else {
      // New package — insert
      await insertPackage(packageId, orgId, packageType, manifest, content);
    }

    // Per-type post-install (version, package upsert, storage upload)
    await postInstallPackage({
      packageType,
      packageId,
      orgId,
      userId: user.id,
      content,
      files,
      zipBuffer: buffer,
    });

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
  router.post("/:scope{@[^/]+}/:name/publish", requireAdmin(), async (c) => {
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
