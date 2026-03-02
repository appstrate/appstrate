import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  listOrgItems,
  getOrgItem,
  upsertOrgItem,
  deleteOrgItem,
  uploadLibraryPackage,
  SKILL_CONFIG,
  EXTENSION_CONFIG,
  type LibraryTypeConfig,
} from "../services/library.ts";
import { extractSkillMeta, validateExtensionSource } from "@appstrate/validation";
import { unzipAndNormalize } from "../services/package-storage.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { inArray } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { profiles } from "@appstrate/db/schema";

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
}

/**
 * Parse a library item upload from a Hono context (multipart ZIP or JSON body).
 * Returns parsed data or a 400 Response on validation error.
 */
async function parseLibraryUpload(
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

    // Allow overriding name/description from form fields
    const formName = formData.get("name") as string | null;
    const formDesc = formData.get("description") as string | null;
    if (formName) name = formName;
    if (formDesc) description = formDesc;

    return { id, name, description, content, normalizedFiles };
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

// --- Route configuration per library type ---

interface LibraryRouteConfig {
  cfg: LibraryTypeConfig;
  parseOpts: { requiredFile: string | null; contentFileExt: string | null; extractMeta: boolean };
  responseKey: string;
  validateContent?: (content: string) => { valid: boolean; errors: string[]; warnings: string[] };
  storageFileName: (id: string) => string;
}

const ROUTE_CONFIGS: Record<string, LibraryRouteConfig> = {
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

function makeListHandler(rcfg: LibraryRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const items = await listOrgItems(orgId, rcfg.cfg);
    const enriched = await enrichWithCreatorNames(items);
    return c.json({ [rcfg.cfg.storageFolder]: enriched });
  };
}

function makeCreateHandler(rcfg: LibraryRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const user = c.get("user");

    const parsed = await parseLibraryUpload(c, rcfg.parseOpts);
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
      {
        id: parsed.id,
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        createdBy: user.id,
      },
      rcfg.cfg,
    );

    if (parsed.normalizedFiles) {
      await uploadLibraryPackage(rcfg.cfg.storageFolder, orgId, parsed.id, parsed.normalizedFiles);
    }

    return c.json(
      {
        [rcfg.responseKey]: { id: item.id, name: item.name, description: item.description },
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      201,
    );
  };
}

function makeGetHandler(rcfg: LibraryRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = c.req.param("id");
    const item = await getOrgItem(orgId, itemId, rcfg.cfg);

    if (!item) {
      return c.json(
        {
          error: "NOT_FOUND",
          message: `${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`,
        },
        404,
      );
    }

    return c.json({ [rcfg.responseKey]: item });
  };
}

function makeUpdateHandler(rcfg: LibraryRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const itemId = c.req.param("id");
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

    const body = await c.req.json<{ name?: string; description?: string; content?: string }>();

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
    const item = await upsertOrgItem(
      orgId,
      {
        id: itemId,
        name: body.name ?? existing.name ?? undefined,
        description: body.description ?? existing.description ?? undefined,
        content: finalContent!,
        createdBy: existing.createdBy ?? user.id,
      },
      rcfg.cfg,
    );

    // Update storage ZIP so container packaging stays in sync
    await uploadLibraryPackage(rcfg.cfg.storageFolder, orgId, itemId, {
      [rcfg.storageFileName(itemId)]: new TextEncoder().encode(finalContent!),
    });

    return c.json({
      [rcfg.responseKey]: { id: item.id, name: item.name, description: item.description },
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  };
}

function makeDeleteHandler(rcfg: LibraryRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = c.req.param("id");
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

export function createLibraryRouter() {
  const router = new Hono<AppEnv>();

  for (const [path, rcfg] of Object.entries(ROUTE_CONFIGS)) {
    router.get(`/${path}`, makeListHandler(rcfg));
    router.post(`/${path}`, requireAdmin(), makeCreateHandler(rcfg));
    router.get(`/${path}/:id`, makeGetHandler(rcfg));
    router.put(`/${path}/:id`, requireAdmin(), makeUpdateHandler(rcfg));
    router.delete(`/${path}/:id`, requireAdmin(), makeDeleteHandler(rcfg));
  }

  return router;
}
