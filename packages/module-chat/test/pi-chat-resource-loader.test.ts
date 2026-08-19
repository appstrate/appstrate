// SPDX-License-Identifier: Apache-2.0

import { $ } from "bun";
import { afterEach, describe, expect, it } from "bun:test";

import { loadPiCodingAgentSdk } from "@appstrate/runner-pi";

import { createPiChatResourceLoader } from "../src/pi-chat/resource-loader.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await $`rm -r ${directory}`.quiet();
  }
});

describe("Pi chat resource policy", () => {
  it("loads inline chat extensions without discovering local skills or context files", async () => {
    const cwd = (await $`mktemp -d /tmp/appstrate-pi-chat-resources.XXXXXX`.text()).trim();
    temporaryDirectories.push(cwd);
    const agentDir = `${cwd}/.pi/agent`;
    const skillDirectory = `${cwd}/.agents/skills/local-only`;
    const extensionDirectory = `${agentDir}/extensions`;
    await $`mkdir -p ${skillDirectory} ${extensionDirectory}`.quiet();
    await Bun.write(`${skillDirectory}/SKILL.md`, "# Local only\n");
    await Bun.write(
      `${extensionDirectory}/local-only.ts`,
      'throw new Error("local extension must not load");\n',
    );
    await Bun.write(`${cwd}/AGENTS.md`, "LOCAL CONTEXT MUST NOT LOAD\n");

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
