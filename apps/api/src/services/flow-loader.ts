import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FlowManifest, LoadedFlow, SkillMeta } from "../types/index.ts";
import { validateManifest } from "./schema.ts";

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

    skills.push({ id: entry, description });
  }

  return skills;
}

export async function loadFlows(): Promise<Map<string, LoadedFlow>> {
  const flows = new Map<string, LoadedFlow>();

  let entries: string[];
  try {
    entries = await readdir(FLOWS_DIR);
  } catch {
    console.warn(`Flows directory not found at ${FLOWS_DIR}`);
    return flows;
  }

  for (const entry of entries) {
    const flowPath = join(FLOWS_DIR, entry);
    const manifestPath = join(flowPath, "manifest.json");
    const promptPath = join(flowPath, "prompt.md");

    const manifestFile = Bun.file(manifestPath);
    const promptFile = Bun.file(promptPath);

    if (!(await manifestFile.exists())) {
      console.warn(`Skipping ${entry}: no manifest.json`);
      continue;
    }

    if (!(await promptFile.exists())) {
      console.warn(`Skipping ${entry}: no prompt.md`);
      continue;
    }

    try {
      const raw = await manifestFile.json();
      const prompt = await promptFile.text();

      // Validate manifest with Zod
      const validation = validateManifest(raw);
      if (!validation.valid) {
        console.warn(`Skipping ${entry}: invalid manifest`);
        for (const err of validation.errors) console.warn(`  - ${err}`);
        continue;
      }
      const manifest = validation.manifest as FlowManifest;

      const skills = await loadFlowSkills(flowPath);

      flows.set(manifest.metadata.name, {
        id: manifest.metadata.name,
        manifest,
        prompt,
        path: flowPath,
        skills,
      });

      const skillCount = skills.length;
      const skillInfo = skillCount > 0 ? ` (${skillCount} skill${skillCount > 1 ? "s" : ""})` : "";
      const outputInfo = manifest.output?.schema
        ? ` [${Object.keys(manifest.output.schema).length} output fields]`
        : "";
      console.log(
        `Loaded flow: ${manifest.metadata.name} (${manifest.metadata.displayName})${skillInfo}${outputInfo}`,
      );
    } catch (e) {
      console.warn(`Skipping ${entry}: ${e instanceof Error ? e.message : "parse error"}`);
    }
  }

  return flows;
}
