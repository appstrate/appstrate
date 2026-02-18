import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { supabase } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import { validateManifest } from "./schema.ts";
import type { FlowManifest, LoadedFlow } from "../types/index.ts";

export const FLOWS_DIR = join(process.cwd(), "flows");

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
      const skills = manifest.requires.skills ?? [];
      const extensions = manifest.requires.extensions ?? [];
      const flowId = manifest.metadata.name;

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

function dbRowToLoadedFlow(row: { id: string; manifest: unknown; prompt: string }): LoadedFlow {
  const manifest = row.manifest as unknown as FlowManifest;
  const skills = manifest.requires.skills ?? [];
  const extensions = manifest.requires.extensions ?? [];

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
  let query = supabase
    .from("flows")
    .select("id, manifest, prompt")
    .eq("id", id);

  if (orgId) {
    query = query.eq("org_id", orgId);
  }

  const { data } = await query.single();
  if (!data) return null;

  return dbRowToLoadedFlow(data);
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
