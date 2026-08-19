// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPiCodingAgentSdk } from "@appstrate/runner-pi";

import { createPiChatResourceLoader } from "../src/pi-chat/resource-loader.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Pi chat resource policy", () => {
  it("loads inline chat extensions without discovering local skills or context files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "appstrate-pi-chat-resources-"));
    temporaryDirectories.push(cwd);
    const agentDir = join(cwd, ".pi", "agent");
    const skillDirectory = join(cwd, ".agents", "skills", "local-only");
    const extensionDirectory = join(agentDir, "extensions");
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(extensionDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "# Local only\n");
    await writeFile(
      join(extensionDirectory, "local-only.ts"),
      'throw new Error("local extension must not load");\n',
    );
    await writeFile(join(cwd, "AGENTS.md"), "LOCAL CONTEXT MUST NOT LOAD\n");

    const sdk = await loadPiCodingAgentSdk();
    const resourceLoader = await createPiChatResourceLoader({
      DefaultResourceLoader: sdk.DefaultResourceLoader,
      SettingsManager: sdk.SettingsManager,
      cwd,
      agentDir,
      systemPrompt: "Appstrate chat prompt",
      extensionFactories: [(pi) => pi.on("before_agent_start", () => undefined)],
    });

    expect(resourceLoader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(resourceLoader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(resourceLoader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(resourceLoader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    expect(resourceLoader.getExtensions().extensions).toHaveLength(1);
    expect(resourceLoader.getSystemPrompt()).toBe("Appstrate chat prompt");
  });
});
