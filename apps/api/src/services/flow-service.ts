import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { supabase } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import { validateManifest } from "./schema.ts";
import {
  isBuiltInSkill,
  isBuiltInExtension,
  getBuiltInSkills,
  getBuiltInExtensions,
} from "./builtin-library.ts";
import type { FlowManifest, LoadedFlow } from "../types/index.ts";

export const FLOWS_DIR = join(process.cwd(), "data", "flows");

// Immutable cache for built-in flows (loaded once at boot, never mutated)
let builtInFlows: ReadonlyMap<string, LoadedFlow> = new Map();

/** Load built-in flows from filesystem into the immutable cache. Call once at boot. */
export async function initFlowService(): Promise<void> {
  const flows = new Map<string, LoadedFlow>();

  let entries: string[];
  try {
    entries = await readdir(FLOWS_DIR);
  } catch {
    logger.warn("Flows directory not found", { path: FLOWS_DIR });
    builtInFlows = flows;
    return;
  }

  for (const entry of entries) {
    const flowPath = join(FLOWS_DIR, entry);
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

      flows.set(flowId, {
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

  builtInFlows = flows;
}

interface DbFlowRow {
  id: string;
  manifest: unknown;
  prompt: string;
  flow_skills?: {
    skill_id: string;
    org_skills: { id: string; name: string | null; description: string | null } | null;
  }[];
  flow_extensions?: {
    extension_id: string;
    org_extensions: { id: string; name: string | null; description: string | null } | null;
  }[];
}

function dbRowToLoadedFlow(row: DbFlowRow): LoadedFlow {
  const manifest = row.manifest as unknown as FlowManifest;

  // Org skills/extensions from DB join tables
  const orgSkills = (row.flow_skills ?? []).map((fs) => ({
    id: fs.skill_id,
    name: fs.org_skills?.name ?? undefined,
    description: fs.org_skills?.description ?? undefined,
  }));

  const orgExtensions = (row.flow_extensions ?? []).map((fe) => ({
    id: fe.extension_id,
    name: fe.org_extensions?.name ?? undefined,
    description: fe.org_extensions?.description ?? undefined,
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
  const seenSkillIds = new Set(orgSkills.map((s) => s.id));
  const skills = [...orgSkills, ...manifestSkills.filter((s) => !seenSkillIds.has(s.id))];

  const seenExtIds = new Set(orgExtensions.map((e) => e.id));
  const extensions = [...orgExtensions, ...manifestExtensions.filter((e) => !seenExtIds.has(e.id))];

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

  // User flows are scoped by org — include skill/extension joins
  let query = supabase
    .from("flows")
    .select(
      `id, manifest, prompt,
       flow_skills(skill_id, org_skills(id, name, description)),
       flow_extensions(extension_id, org_extensions(id, name, description))`,
    )
    .eq("id", id);

  if (orgId) {
    query = query.eq("org_id", orgId);
  }

  const { data } = await query.single();
  if (!data) return null;

  return dbRowToLoadedFlow(data as DbFlowRow);
}

/** List all flows: built-in (from cache) + user flows (from DB, scoped by org). */
export async function listFlows(orgId?: string): Promise<LoadedFlow[]> {
  let query = supabase.from("flows").select("id, manifest, prompt");
  if (orgId) {
    query = query.eq("org_id", orgId);
  }
  const { data } = await query;
  const userFlows = (data ?? []).map(dbRowToLoadedFlow);

  return [...builtInFlows.values(), ...userFlows];
}

/** Get all flow IDs (built-in + user, scoped by org). Used for collision checks. */
export async function getAllFlowIds(orgId?: string): Promise<string[]> {
  const builtInIds = [...builtInFlows.keys()];
  let query = supabase.from("flows").select("id");
  if (orgId) {
    query = query.eq("org_id", orgId);
  }
  const { data } = await query;
  const userIds = (data ?? []).map((r) => r.id);

  return [...builtInIds, ...userIds];
}

/** Check if a flow exists (built-in or user). */
export async function flowExists(id: string): Promise<boolean> {
  if (builtInFlows.has(id)) return true;
  const { count } = await supabase
    .from("flows")
    .select("id", { count: "exact", head: true })
    .eq("id", id);
  return (count ?? 0) > 0;
}

/** Get the count of built-in flows loaded at boot. */
export function getBuiltInFlowCount(): number {
  return builtInFlows.size;
}

/** Check if a flow ID is a built-in flow. */
export function isBuiltIn(id: string): boolean {
  return builtInFlows.has(id);
}
