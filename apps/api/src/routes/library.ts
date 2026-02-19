import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  listOrgSkills,
  getOrgSkill,
  upsertOrgSkill,
  deleteOrgSkill,
  listOrgExtensions,
  getOrgExtension,
  upsertOrgExtension,
  deleteOrgExtension,
  uploadLibraryPackage,
} from "../services/library.ts";
import { extractSkillMeta } from "../services/skill-utils.ts";
import { unzipAndNormalize } from "../services/flow-package.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { supabase } from "../lib/supabase.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Enrich items with creator display names (batch lookup). */
async function enrichWithCreatorNames<T extends { createdBy?: string | null }>(
  items: T[],
): Promise<(T & { createdByName?: string })[]> {
  const userIds = [...new Set(items.map((i) => i.createdBy).filter(Boolean))] as string[];
  if (userIds.length === 0) return items;

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", userIds);

  const nameMap = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

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
      return c.json({ error: "VALIDATION_ERROR", message: "Fichier requis" }, 400);
    }

    if (!file.name.endsWith(".zip")) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Seuls les fichiers .zip sont acceptes" },
        400,
      );
    }

    const id = file.name.replace(/\.zip$/i, "");
    if (!SLUG_RE.test(id)) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Nom de fichier invalide (slug kebab-case requis)" },
        400,
      );
    }

    let normalizedFiles: Record<string, Uint8Array>;
    try {
      normalizedFiles = unzipAndNormalize(Buffer.from(await file.arrayBuffer()));
    } catch {
      return c.json({ error: "VALIDATION_ERROR", message: "Fichier ZIP invalide" }, 400);
    }

    // Find the content file
    let contentFile: string | undefined;
    if (opts.requiredFile) {
      if (!normalizedFiles[opts.requiredFile]) {
        return c.json(
          { error: "VALIDATION_ERROR", message: `Le ZIP doit contenir ${opts.requiredFile}` },
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
            message: `Le ZIP doit contenir un fichier ${opts.contentFileExt}`,
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
    return c.json({ error: "VALIDATION_ERROR", message: "id et content sont requis" }, 400);
  }

  if (!SLUG_RE.test(body.id)) {
    return c.json(
      { error: "VALIDATION_ERROR", message: "id invalide (slug kebab-case requis)" },
      400,
    );
  }

  let { name, description } = body;
  if (opts.extractMeta && (!name || !description)) {
    const meta = extractSkillMeta(body.content);
    if (!name) name = meta.name || undefined;
    if (!description) description = meta.description || undefined;
  }

  return { id: body.id, name, description, content: body.content };
}

export function createLibraryRouter() {
  const router = new Hono<AppEnv>();

  // -------------------------------------------------------
  // Skills
  // -------------------------------------------------------

  router.get("/skills", async (c) => {
    const orgId = c.get("orgId");
    const skills = await listOrgSkills(orgId);
    const enriched = await enrichWithCreatorNames(skills);
    return c.json({ skills: enriched });
  });

  router.post("/skills", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");

    const parsed = await parseLibraryUpload(c, {
      requiredFile: "SKILL.md",
      contentFileExt: null,
      extractMeta: true,
    });
    if (parsed instanceof Response) return parsed;

    const skill = await upsertOrgSkill(orgId, {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      createdBy: user.id,
    });

    if (parsed.normalizedFiles) {
      await uploadLibraryPackage("skills", orgId, parsed.id, parsed.normalizedFiles);
    }

    return c.json(
      { skill: { id: skill.id, name: skill.name, description: skill.description } },
      201,
    );
  });

  router.get("/skills/:id", async (c) => {
    const orgId = c.get("orgId");
    const skillId = c.req.param("id");
    const skill = await getOrgSkill(orgId, skillId);

    if (!skill) {
      return c.json({ error: "NOT_FOUND", message: `Skill '${skillId}' introuvable` }, 404);
    }

    return c.json({ skill });
  });

  router.put("/skills/:id", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const skillId = c.req.param("id");

    const existing = await getOrgSkill(orgId, skillId);
    if (!existing) {
      return c.json({ error: "NOT_FOUND", message: `Skill '${skillId}' introuvable` }, 404);
    }

    const body = await c.req.json<{ name?: string; description?: string; content?: string }>();

    const skill = await upsertOrgSkill(orgId, {
      id: skillId,
      name: body.name ?? existing.name ?? undefined,
      description: body.description ?? existing.description ?? undefined,
      content: body.content ?? existing.content,
      createdBy: existing.createdBy ?? user.id,
    });

    return c.json({ skill: { id: skill.id, name: skill.name, description: skill.description } });
  });

  router.delete("/skills/:id", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const skillId = c.req.param("id");

    const result = await deleteOrgSkill(orgId, skillId);
    if (!result.ok) {
      return c.json(
        {
          error: "IN_USE",
          message: `Le skill '${skillId}' est utilise par ${result.flows!.length} flow(s)`,
          flows: result.flows,
        },
        409,
      );
    }

    return c.body(null, 204);
  });

  // -------------------------------------------------------
  // Extensions
  // -------------------------------------------------------

  router.get("/extensions", async (c) => {
    const orgId = c.get("orgId");
    const extensions = await listOrgExtensions(orgId);
    const enriched = await enrichWithCreatorNames(extensions);
    return c.json({ extensions: enriched });
  });

  router.post("/extensions", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");

    const parsed = await parseLibraryUpload(c, {
      requiredFile: null,
      contentFileExt: ".ts",
      extractMeta: false,
    });
    if (parsed instanceof Response) return parsed;

    const ext = await upsertOrgExtension(orgId, {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      createdBy: user.id,
    });

    if (parsed.normalizedFiles) {
      await uploadLibraryPackage("extensions", orgId, parsed.id, parsed.normalizedFiles);
    }

    return c.json({ extension: { id: ext.id, name: ext.name, description: ext.description } }, 201);
  });

  router.get("/extensions/:id", async (c) => {
    const orgId = c.get("orgId");
    const extId = c.req.param("id");
    const ext = await getOrgExtension(orgId, extId);

    if (!ext) {
      return c.json({ error: "NOT_FOUND", message: `Extension '${extId}' introuvable` }, 404);
    }

    return c.json({ extension: ext });
  });

  router.put("/extensions/:id", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const extId = c.req.param("id");

    const existing = await getOrgExtension(orgId, extId);
    if (!existing) {
      return c.json({ error: "NOT_FOUND", message: `Extension '${extId}' introuvable` }, 404);
    }

    const body = await c.req.json<{ name?: string; description?: string; content?: string }>();

    const ext = await upsertOrgExtension(orgId, {
      id: extId,
      name: body.name ?? existing.name ?? undefined,
      description: body.description ?? existing.description ?? undefined,
      content: body.content ?? existing.content,
      createdBy: existing.createdBy ?? user.id,
    });

    return c.json({
      extension: { id: ext.id, name: ext.name, description: ext.description },
    });
  });

  router.delete("/extensions/:id", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const extId = c.req.param("id");

    const result = await deleteOrgExtension(orgId, extId);
    if (!result.ok) {
      return c.json(
        {
          error: "IN_USE",
          message: `L'extension '${extId}' est utilisee par ${result.flows!.length} flow(s)`,
          flows: result.flows,
        },
        409,
      );
    }

    return c.body(null, 204);
  });

  return router;
}
