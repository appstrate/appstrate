// SPDX-License-Identifier: Apache-2.0

/**
 * A Pi session built by the platform sees only what the platform gives it. On
 * the host (`RUN_ADAPTER=process`, the CLI) Pi would otherwise read whoever
 * runs the process: `~/.agents/skills`, the `agentDir` resource directories and
 * context files, and `.agents/skills` / `AGENTS.md` in every ancestor of the
 * working directory. Each fixture below seeds one of those, under a temporary
 * `HOME`, next to a skill the platform materialised in the workspace.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPiCodingAgentSdk } from "../src/pi-sdk.ts";
import { createIsolatedResourceLoader } from "../src/isolated-resource-loader.ts";
import type { ExtensionFactory } from "../src/index.ts";
import { runAgainstStub, stubGatewayModel } from "./helpers.ts";

/** Text that must never reach a session, one per host source. */
const HOST_MARKERS = [
  "home-skill",
  "agentdir-skill",
  "ancestor-skill",
  "AGENTDIR-CONTEXT",
  "ANCESTOR-CONTEXT",
  "HOST-APPEND",
];

interface Fixture {
  root: string;
  cwd: string;
  agentDir: string;
  platformSkills: string;
  /** Written by the host extension's module body if Pi ever loads it. */
  extensionMarker: string;
}

function skillMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill.\n---\nBody of ${name}.\n`;
}

async function seedHostAndPlatform(root: string): Promise<Fixture> {
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const agentDir = join(root, "pi-agent");
  const platformSkills = join(cwd, ".pi", "skills");
  const extensionMarker = join(root, "host-extension-loaded");

  await Bun.write(
    join(home, ".agents", "skills", "home-skill", "SKILL.md"),
    skillMarkdown("home-skill"),
  );
  await Bun.write(
    join(agentDir, "skills", "agentdir-skill", "SKILL.md"),
    skillMarkdown("agentdir-skill"),
  );
  await Bun.write(
    join(agentDir, "extensions", "host-extension.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(extensionMarker)}, "loaded");\nexport default function () {}\n`,
  );
  await Bun.write(join(agentDir, "prompts", "host-prompt.md"), "Host prompt template.\n");
  await Bun.write(join(agentDir, "AGENTS.md"), "AGENTDIR-CONTEXT\n");
  await Bun.write(join(agentDir, "APPEND_SYSTEM.md"), "HOST-APPEND\n");
  await Bun.write(join(root, "AGENTS.md"), "ANCESTOR-CONTEXT\n");
  await Bun.write(
    join(root, ".agents", "skills", "ancestor-skill", "SKILL.md"),
    skillMarkdown("ancestor-skill"),
  );
  await Bun.write(
    join(platformSkills, "platform-skill", "SKILL.md"),
    skillMarkdown("platform-skill"),
  );
  return { root, cwd, agentDir, platformSkills, extensionMarker };
}

const savedHome = process.env.HOME;
let root: string | undefined;
let fixture: Fixture | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runner-pi-isolation-"));
  process.env.HOME = join(root, "home");
  fixture = await seedHostAndPlatform(root);
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  fixture = undefined;
});

/** The current test's fixture, seeded by `beforeEach`. */
function seeded(): Fixture {
  if (!fixture) throw new Error("fixture not seeded");
  return fixture;
}

describe("createIsolatedResourceLoader", () => {
  async function load(skillPaths: string[], extensionFactories: ExtensionFactory[] = []) {
    const { DefaultResourceLoader, SettingsManager } = await loadPiCodingAgentSdk();
    return createIsolatedResourceLoader({
      DefaultResourceLoader,
      SettingsManager,
      cwd: seeded().cwd,
      agentDir: seeded().agentDir,
      systemPrompt: "Platform prompt",
      extensionFactories,
      skillPaths,
    });
  }

  it("loads the given skills and inline extensions, and nothing from the host", async () => {
    const loader = await load(
      [seeded().platformSkills],
      [
        (pi) => {
          pi.on("agent_start", () => {});
        },
      ],
    );

    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["platform-skill"]);
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getSystemPrompt()).toBe("Platform prompt");
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(1);
    expect(await Bun.file(seeded().extensionMarker).exists()).toBe(false);
  });

  it("loads no skill when given none", async () => {
    const loader = await load([]);
    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
  });

  /**
   * The flags (`noSkills`, …) are applied after Pi's package manager has
   * already walked the user-scope directories, so an empty RESULT does not
   * prove the walk did not happen. Ask the package manager itself: unshimmed,
   * it reports the seeded host skills and extension.
   */
  it("never lets Pi's package manager scan the filesystem", async () => {
    const loader = await load([seeded().platformSkills]);
    // `packageManager` is private in Pi's TypeScript surface, a normal field at runtime.
    const packageManager = Reflect.get(loader, "packageManager") as {
      resolve: () => Promise<{ skills: unknown[]; extensions: unknown[] }>;
    };
    const resolved = await packageManager.resolve();
    expect(resolved.skills).toEqual([]);
    expect(resolved.extensions).toEqual([]);
  });
});

describe("PiRunner on the host", () => {
  it("sends the model the platform's skills and none of the host's resources", async () => {
    let platformExtensionLoaded = false;
    const { requests } = await runAgainstStub({
      model: stubGatewayModel("openai-completions"),
      runner: {
        systemPrompt: "Platform prompt",
        cwd: seeded().cwd,
        agentDir: seeded().agentDir,
        extensionFactories: [
          () => {
            platformExtensionLoaded = true;
          },
        ],
        modelRetry: false,
      },
    });

    const requestBody = requests[0]?.body;
    expect(requestBody).toContain("Platform prompt");
    expect(requestBody).toContain("platform-skill");
    for (const marker of HOST_MARKERS) expect(requestBody).not.toContain(marker);
    expect(platformExtensionLoaded).toBe(true);
    expect(await Bun.file(seeded().extensionMarker).exists()).toBe(false);
  });
});
