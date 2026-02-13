import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { supabase } from "../lib/supabase.ts";
import { validateManifest } from "./schema.ts";
import type { FlowManifest, SkillMeta } from "../types/index.ts";
import type { Json } from "@appstrate/shared-types";

const FLOWS_DIR = join(process.cwd(), "flows");

function computeContentHash(manifest: unknown, prompt: string, skills: SkillMeta[]): string {
  const payload = JSON.stringify({ manifest, prompt, skills });
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(payload);
  return hash.digest("hex");
}

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

export async function seedBuiltInFlows(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(FLOWS_DIR);
  } catch {
    console.warn(`Flows directory not found at ${FLOWS_DIR}`);
    return;
  }

  // Get existing built-in flows from DB for hash comparison
  const { data: existingRows } = await supabase
    .from("flows")
    .select("id, content_hash")
    .eq("source", "built-in");
  const existingHashes = new Map((existingRows ?? []).map((r) => [r.id, r.content_hash]));

  let seeded = 0;
  let skipped = 0;

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
        console.warn(`Skipping seed for ${entry}: invalid manifest`);
        continue;
      }

      const manifest = validation.manifest as FlowManifest;
      const skills = await loadFlowSkills(flowPath);
      const contentHash = computeContentHash(manifest, prompt, skills);
      const flowId = manifest.metadata.name;

      // Skip if hash is unchanged
      if (existingHashes.get(flowId) === contentHash) {
        skipped++;
        continue;
      }

      const { error } = await supabase.from("flows").upsert(
        {
          id: flowId,
          manifest: manifest as unknown as Json,
          prompt,
          skills: skills as unknown as Json,
          source: "built-in",
          content_hash: contentHash,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );

      if (error) {
        console.error(`Failed to seed flow ${flowId}:`, error.message);
        continue;
      }

      seeded++;
      console.log(`Seeded flow: ${flowId} (${manifest.metadata.displayName})`);
    } catch (e) {
      console.warn(`Skipping seed for ${entry}: ${e instanceof Error ? e.message : "parse error"}`);
    }
  }

  if (seeded > 0 || skipped > 0) {
    console.log(`Seed complete: ${seeded} seeded, ${skipped} unchanged`);
  }
}
