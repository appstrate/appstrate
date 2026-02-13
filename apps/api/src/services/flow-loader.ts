import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { supabase } from "../lib/supabase.ts";
import { validateManifest } from "./schema.ts";
import type { FlowManifest, LoadedFlow, SkillMeta } from "../types/index.ts";

const FLOWS_DIR = join(process.cwd(), "flows");

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
    let description = "";
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1]!.match(/description:\s*(.+)/);
      if (descMatch) description = descMatch[1]!.trim();
    }

    skills.push({ id: entry, description, content });
  }

  return skills;
}

async function loadBuiltInFlows(flows: Map<string, LoadedFlow>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(FLOWS_DIR);
  } catch {
    console.warn(`Flows directory not found at ${FLOWS_DIR}`);
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
        console.warn(`Skipping ${entry}: invalid manifest`);
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
      const skillInfo = skillCount > 0 ? ` (${skillCount} skill${skillCount > 1 ? "s" : ""})` : "";
      console.log(`Loaded built-in flow: ${flowId} (${manifest.metadata.displayName})${skillInfo}`);
    } catch (e) {
      console.warn(`Skipping ${entry}: ${e instanceof Error ? e.message : "parse error"}`);
    }
  }
}

async function loadUserFlows(flows: Map<string, LoadedFlow>): Promise<void> {
  const { data, error } = await supabase.from("flows").select("*");
  if (error) {
    console.error("Failed to load user flows from DB:", error.message);
    return;
  }

  for (const row of data ?? []) {
    const skills: SkillMeta[] = (
      (row.skills ?? []) as { id: string; description: string; content?: string }[]
    ).map((s) => ({ id: s.id, description: s.description, content: s.content }));

    flows.set(row.id, {
      id: row.id,
      manifest: row.manifest as unknown as FlowManifest,
      prompt: row.prompt,
      skills,
      source: "user",
    });

    const skillCount = skills.length;
    const skillInfo = skillCount > 0 ? ` (${skillCount} skill${skillCount > 1 ? "s" : ""})` : "";
    const manifest = row.manifest as { metadata?: { displayName?: string } };
    console.log(
      `Loaded user flow: ${row.id} (${manifest.metadata?.displayName ?? row.id})${skillInfo}`,
    );
  }
}

export async function loadFlows(): Promise<Map<string, LoadedFlow>> {
  const flows = new Map<string, LoadedFlow>();

  await loadBuiltInFlows(flows);
  await loadUserFlows(flows);

  return flows;
}
