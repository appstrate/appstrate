import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FlowManifest, LoadedFlow } from "../types/index.ts";

const FLOWS_DIR = join(import.meta.dir, "../../flows");

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
      const manifest: FlowManifest = await manifestFile.json();
      const prompt = await promptFile.text();

      // Basic validation
      if (!manifest.metadata?.name || !manifest.metadata?.description) {
        console.warn(`Skipping ${entry}: manifest missing required fields (metadata.name, metadata.description)`);
        continue;
      }

      flows.set(manifest.metadata.name, {
        id: manifest.metadata.name,
        manifest,
        prompt,
        path: flowPath,
      });

      console.log(`Loaded flow: ${manifest.metadata.name} (${manifest.metadata.displayName})`);
    } catch (e) {
      console.warn(`Skipping ${entry}: ${e instanceof Error ? e.message : "parse error"}`);
    }
  }

  return flows;
}
