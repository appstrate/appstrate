import { supabase } from "../lib/supabase.ts";
import type { FlowManifest, LoadedFlow, SkillMeta } from "../types/index.ts";

export async function loadFlows(): Promise<Map<string, LoadedFlow>> {
  const flows = new Map<string, LoadedFlow>();

  const { data, error } = await supabase.from("flows").select("*");
  if (error) {
    console.error("Failed to load flows from DB:", error.message);
    return flows;
  }

  for (const row of data ?? []) {
    const skills: SkillMeta[] = (
      (row.skills ?? []) as { id: string; description: string; content?: string }[]
    ).map((s) => ({ id: s.id, description: s.description, content: s.content }));

    flows.set(row.id, {
      id: row.id,
      manifest: row.manifest as FlowManifest,
      prompt: row.prompt,
      skills,
      source: row.source as "built-in" | "user",
    });

    const skillCount = skills.length;
    const skillInfo = skillCount > 0 ? ` (${skillCount} skill${skillCount > 1 ? "s" : ""})` : "";
    const manifest = row.manifest as { metadata?: { displayName?: string } };
    console.log(`Loaded flow: ${row.id} (${manifest.metadata?.displayName ?? row.id})${skillInfo}`);
  }

  return flows;
}
