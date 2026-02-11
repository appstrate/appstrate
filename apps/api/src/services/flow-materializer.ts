import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { UserFlowRow } from "./user-flows.ts";

export const USER_FLOWS_DIR = join(process.cwd(), "data", "user-flows");

export async function materializeFlow(flow: UserFlowRow, baseDir: string): Promise<string> {
  const flowDir = join(baseDir, flow.id);
  await mkdir(flowDir, { recursive: true });

  await writeFile(join(flowDir, "manifest.json"), JSON.stringify(flow.manifest, null, 2));
  await writeFile(join(flowDir, "prompt.md"), flow.prompt);

  if (flow.skills && flow.skills.length > 0) {
    for (const skill of flow.skills) {
      const skillDir = join(flowDir, "skills", skill.id);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), skill.content);
    }
  }

  return flowDir;
}

export async function materializeAllFlows(
  flows: UserFlowRow[],
): Promise<Map<string, string>> {
  // Clean and recreate user-flows directory
  await rm(USER_FLOWS_DIR, { recursive: true, force: true });
  await mkdir(USER_FLOWS_DIR, { recursive: true });

  const paths = new Map<string, string>();

  for (const flow of flows) {
    const path = await materializeFlow(flow, USER_FLOWS_DIR);
    paths.set(flow.id, path);
  }

  return paths;
}

export async function cleanupFlowDir(flowId: string): Promise<void> {
  const flowDir = join(USER_FLOWS_DIR, flowId);
  await rm(flowDir, { recursive: true, force: true });
}
