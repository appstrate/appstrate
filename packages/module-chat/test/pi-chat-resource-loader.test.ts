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

  /**
   * The assertions above test the OUTCOME (nothing loads), and `noSkills` alone
   * delivers that outcome — so they stay green with `disablePackageDiscovery`
   * removed. Verified by doing exactly that. They therefore guard nothing about
   * the shim, whose whole job is to stop the SCAN, and whose own comment invites
   * the next reader to delete it once Pi exposes package-manager injection.
   *
   * Pi runs `packageManager.resolve()` before it consults `noSkills`, and that
   * resolve walks user-scope directories OUTSIDE any project-trust gate —
   * `<agentDir>/{extensions,skills,prompts,themes}` and `~/.agents/skills` —
   * with a synchronous `readdirSync` + `statSync` per entry, on every turn.
   *
   * So assert the scan, not its result: seed a skill in a directory the walker
   * reaches, and require the package manager to report nothing. Without the
   * shim the seeded skill comes back and this fails.
   */
  it("never lets Pi's package manager scan the filesystem", async () => {
    const cwd = (await $`mktemp -d /tmp/appstrate-pi-chat-scan.XXXXXX`.text()).trim();
    temporaryDirectories.push(cwd);
    const agentDir = `${cwd}/.pi/agent`;
    // User scope, reached with no `projectTrusted` check.
    const seeded = `${agentDir}/skills/would-be-discovered`;
    await $`mkdir -p ${seeded}`.quiet();
    await Bun.write(`${seeded}/SKILL.md`, "---\nname: leak\ndescription: leak\n---\n");

    const sdk = await loadPiCodingAgentSdk();
    const resourceLoader = await createPiChatResourceLoader({
      DefaultResourceLoader: sdk.DefaultResourceLoader,
      SettingsManager: sdk.SettingsManager,
      cwd,
      agentDir,
      systemPrompt: "Appstrate chat prompt",
      extensionFactories: [],
    });

    // `packageManager` is private in Pi's TypeScript surface but a normal
    // instance field at runtime — the same access the shim itself uses.
    const packageManager = Reflect.get(resourceLoader, "packageManager") as {
      resolve: () => Promise<{ skills: unknown[]; extensions: unknown[] }>;
      resolveExtensionSources: (s: string[]) => Promise<{ extensions: unknown[] }>;
    };
    const resolved = await packageManager.resolve();
    expect(resolved.skills).toEqual([]);
    expect(resolved.extensions).toEqual([]);
    // Dropped: `expect((await resolveExtensionSources([])).extensions).toEqual([])`
    // asserted nothing. `DefaultPackageManager.resolveExtensionSources` maps
    // over its argument, so an empty list returns empty with or without the
    // shim — it passed identically against the unshimmed loader. The two
    // assertions above carry the real claim, and they are non-vacuous because
    // the fixture seeds `<agentDir>/skills/would-be-discovered/SKILL.md` in the
    // directory `addAutoDiscoveredResources` scans unconditionally.
  });
});
