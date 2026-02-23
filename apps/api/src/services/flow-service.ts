import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { eq, and, count } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { flows, flowSkills, flowExtensions, orgSkills, orgExtensions } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { validateManifest } from "./schema.ts";
import {
  isBuiltInSkill,
  isBuiltInExtension,
  getBuiltInSkills,
  getBuiltInExtensions,
} from "./builtin-library.ts";
import type { FlowManifest, LoadedFlow } from "../types/index.ts";

// Module-level directory, initialized by initFlowService()
let flowsDir: string | null = null;

// Immutable cache for built-in flows (loaded once at boot, never mutated)
let builtInFlows: ReadonlyMap<string, LoadedFlow> = new Map();

/** Get the flows directory path (null if DATA_DIR not configured). */
export function getFlowsDir(): string | null {
  return flowsDir;
}

/** Load built-in flows from filesystem into the immutable cache. Call once at boot. */
export async function initFlowService(dataDir?: string): Promise<void> {
  if (!dataDir) {
    logger.info("Built-in flows disabled (no dataDir)");
    return;
  }

  flowsDir = join(dataDir, "flows");
  const flowsMap = new Map<string, LoadedFlow>();

  let entries: string[];
  try {
    entries = await readdir(flowsDir);
  } catch {
    logger.warn("Flows directory not found", { path: flowsDir });
    builtInFlows = flowsMap;
    return;
  }

  for (const entry of entries) {
    const flowPath = join(flowsDir, entry);
    const manifestFile = Bun.file(join(flowPath, "manifest.json"));
    const promptFile = Bun.file(join(flowPath, "prompt.md"));

    if (!(await manifestFile.exists()) || !(await promptFile.exists())) {
      continue;
    }

    try {
      const raw = await manifestFile.json();
      const prompt = await promptFile.text();

      const validation = validateManifest(raw);
      if (!validation.valid) {
        logger.warn("Skipping flow: invalid manifest", { entry });
        continue;
      }

      const manifest = validation.manifest as FlowManifest;
      const flowId = manifest.metadata.id;

      // Resolve skill/extension IDs to SkillMeta using built-in library
      const skills = (manifest.requires.skills ?? []).map((id) => {
        const builtIn = getBuiltInSkills().get(id);
        return { id, name: builtIn?.name, description: builtIn?.description };
      });
      const extensions = (manifest.requires.extensions ?? []).map((id) => {
        const builtIn = getBuiltInExtensions().get(id);
        return { id, name: builtIn?.name, description: builtIn?.description };
      });

      flowsMap.set(flowId, {
        id: flowId,
        manifest,
        prompt,
        skills,
        extensions,
        source: "built-in",
      });

      logger.info("Loaded built-in flow", {
        flowId,
        displayName: manifest.metadata.displayName,
        skillCount: skills.length,
        extensionCount: extensions.length,
      });
    } catch (e) {
      logger.warn("Skipping flow: parse error", {
        entry,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  builtInFlows = flowsMap;
}

interface DbFlowRow {
  id: string;
  manifest: unknown;
  prompt: string;
  orgSkillRefs?: { skillId: string; name: string | null; description: string | null }[];
  orgExtRefs?: { extensionId: string; name: string | null; description: string | null }[];
}

function dbRowToLoadedFlow(row: DbFlowRow): LoadedFlow {
  const manifest = row.manifest as unknown as FlowManifest;

  // Org skills/extensions from DB join tables
  const orgSkillList = (row.orgSkillRefs ?? []).map((fs) => ({
    id: fs.skillId,
    name: fs.name ?? undefined,
    description: fs.description ?? undefined,
  }));

  const orgExtList = (row.orgExtRefs ?? []).map((fe) => ({
    id: fe.extensionId,
    name: fe.name ?? undefined,
    description: fe.description ?? undefined,
  }));

  // Built-in skills/extensions declared in manifest (IDs are strings)
  const manifestSkills = (manifest.requires.skills ?? [])
    .filter((id) => isBuiltInSkill(id))
    .map((id) => {
      const builtIn = getBuiltInSkills().get(id);
      return {
        id,
        name: builtIn?.name,
        description: builtIn?.description,
      };
    });

  const manifestExtensions = (manifest.requires.extensions ?? [])
    .filter((id) => isBuiltInExtension(id))
    .map((id) => {
      const builtIn = getBuiltInExtensions().get(id);
      return {
        id,
        name: builtIn?.name,
        description: builtIn?.description,
      };
    });

  // Merge: org items + built-in items (deduplicate by ID)
  const seenSkillIds = new Set(orgSkillList.map((s) => s.id));
  const skills = [...orgSkillList, ...manifestSkills.filter((s) => !seenSkillIds.has(s.id))];

  const seenExtIds = new Set(orgExtList.map((e) => e.id));
  const extensions = [...orgExtList, ...manifestExtensions.filter((e) => !seenExtIds.has(e.id))];

  return {
    id: row.id,
    manifest,
    prompt: row.prompt,
    skills,
    extensions,
    source: "user",
  };
}

/** Get a single flow by ID. Checks built-in cache first, then DB filtered by orgId. */
export async function getFlow(id: string, orgId?: string): Promise<LoadedFlow | null> {
  // Built-in flows are global (accessible in all orgs)
  const builtIn = builtInFlows.get(id);
  if (builtIn) return builtIn;

  // User flows are scoped by org
  const conditions = [eq(flows.id, id)];
  if (orgId) {
    conditions.push(eq(flows.orgId, orgId));
  }

  const flowRows = await db
    .select({ id: flows.id, manifest: flows.manifest, prompt: flows.prompt })
    .from(flows)
    .where(and(...conditions))
    .limit(1);

  const flowRow = flowRows[0];
  if (!flowRow) return null;

  // Fetch skill and extension joins
  const [skillRefs, extRefs] = await Promise.all([
    db
      .select({
        skillId: flowSkills.skillId,
        name: orgSkills.name,
        description: orgSkills.description,
      })
      .from(flowSkills)
      .leftJoin(
        orgSkills,
        and(eq(flowSkills.skillId, orgSkills.id), eq(flowSkills.orgId, orgSkills.orgId)),
      )
      .where(eq(flowSkills.flowId, id)),
    db
      .select({
        extensionId: flowExtensions.extensionId,
        name: orgExtensions.name,
        description: orgExtensions.description,
      })
      .from(flowExtensions)
      .leftJoin(
        orgExtensions,
        and(
          eq(flowExtensions.extensionId, orgExtensions.id),
          eq(flowExtensions.orgId, orgExtensions.orgId),
        ),
      )
      .where(eq(flowExtensions.flowId, id)),
  ]);

  return dbRowToLoadedFlow({
    id: flowRow.id,
    manifest: flowRow.manifest,
    prompt: flowRow.prompt,
    orgSkillRefs: skillRefs,
    orgExtRefs: extRefs,
  });
}

/** List all flows: built-in (from cache) + user flows (from DB, scoped by org). */
export async function listFlows(orgId?: string): Promise<LoadedFlow[]> {
  const conditions = orgId ? [eq(flows.orgId, orgId)] : [];
  const rows = await db
    .select({ id: flows.id, manifest: flows.manifest, prompt: flows.prompt })
    .from(flows)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const userFlows = rows.map((row) =>
    dbRowToLoadedFlow({ id: row.id, manifest: row.manifest, prompt: row.prompt }),
  );

  return [...builtInFlows.values(), ...userFlows];
}

/** Get all flow IDs (built-in + user, scoped by org). Used for collision checks. */
export async function getAllFlowIds(orgId?: string): Promise<string[]> {
  const builtInIds = [...builtInFlows.keys()];
  const conditions = orgId ? [eq(flows.orgId, orgId)] : [];
  const rows = await db
    .select({ id: flows.id })
    .from(flows)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const userIds = rows.map((r) => r.id);
  return [...builtInIds, ...userIds];
}

/** Check if a flow exists (built-in or user). */
export async function flowExists(id: string): Promise<boolean> {
  if (builtInFlows.has(id)) return true;
  const rows = await db.select({ cnt: count() }).from(flows).where(eq(flows.id, id));
  return (rows[0]?.cnt ?? 0) > 0;
}

/** Get the count of built-in flows loaded at boot. */
export function getBuiltInFlowCount(): number {
  return builtInFlows.size;
}

/** Check if a flow ID is a built-in flow. */
export function isBuiltIn(id: string): boolean {
  return builtInFlows.has(id);
}
