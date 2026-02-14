import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { supabase } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import { validateManifest } from "./schema.ts";
import type { FlowManifest, LoadedFlow, SkillMeta } from "../types/index.ts";
import { extractSkillDescription } from "./skill-utils.ts";

const FLOWS_DIR = join(process.cwd(), "flows");

// Immutable cache for built-in flows (loaded once at boot, never mutated)
let builtInFlows: ReadonlyMap<string, LoadedFlow> = new Map();

async function loadFlowSkills(flowPath: string): Promise<SkillMeta[]> {
  const skillsDir = join(flowPath, "skills");
  const skills: SkillMeta[] = [];

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const skillFile = Bun.file(join(skillsDir, entry, "SKILL.md"));
    if (!(await skillFile.exists())) continue;

    const content = await skillFile.text();
    const description = extractSkillDescription(content);

    skills.push({ id: entry, description, content });
  }

  return skills;
}

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
      const skills = await loadFlowSkills(flowPath);
      const flowId = manifest.metadata.name;

      flows.set(flowId, {
        id: flowId,
        manifest,
        prompt,
        skills,
        source: "built-in",
      });

      const skillCount = skills.length;
      logger.info("Loaded built-in flow", {
        flowId,
        displayName: manifest.metadata.displayName,
        skillCount,
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

function dbRowToLoadedFlow(row: {
  id: string;
  manifest: unknown;
  prompt: string;
  skills: unknown;
}): LoadedFlow {
  const skills: SkillMeta[] = (
    (row.skills ?? []) as { id: string; description: string; content?: string }[]
  ).map((s) => ({ id: s.id, description: s.description, content: s.content }));

  return {
    id: row.id,
    manifest: row.manifest as unknown as FlowManifest,
    prompt: row.prompt,
    skills,
    source: "user",
  };
}

/** Get a single flow by ID. Checks built-in cache first, then DB. */
export async function getFlow(id: string): Promise<LoadedFlow | null> {
  const builtIn = builtInFlows.get(id);
  if (builtIn) return builtIn;

  const { data } = await supabase.from("flows").select("*").eq("id", id).single();
  if (!data) return null;

  return dbRowToLoadedFlow(data);
}

/** List all flows: built-in (from cache) + user flows (from DB). */
export async function listFlows(): Promise<LoadedFlow[]> {
  const { data } = await supabase.from("flows").select("*");
  const userFlows = (data ?? []).map(dbRowToLoadedFlow);

  return [...builtInFlows.values(), ...userFlows];
}

/** Get all flow IDs (built-in + user). Used for collision checks. */
export async function getAllFlowIds(): Promise<string[]> {
  const builtInIds = [...builtInFlows.keys()];
  const { data } = await supabase.from("flows").select("id");
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
