// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate packages sync` — agent commands (issue #1268, D18–D25).
 *
 * Same harness as `packages-sync-command.test.ts`: the command is called
 * directly with a per-test `createMemoryIO()` sink, throw-away config / data /
 * `HOME` directories, and the shared stub server serving skills AND agents.
 * What is asserted here is the wiring: which space the agents come from, which
 * target receives them, when a command is rewritten, and what never reaches
 * the disk.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packagesSyncCommand } from "../src/commands/packages-sync.ts";
import { getDataDir } from "../src/lib/config.ts";
import { getStatePath } from "../src/lib/skills-sync/state.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { ExitError } from "./helpers/process-exit.ts";
import {
  createSkillServer,
  skillMd,
  type AgentFixture,
  type SkillFixture,
  type SpaceFixture,
} from "./helpers/skills-server.ts";

// Platform-shaped: the command writes the space id, and refuses any other shape.
const PINNED = "spc_00000000-0000-4000-8000-000000000001";
const OTHER = "spc_00000000-0000-4000-8000-000000000002";
const SPACES: SpaceFixture[] = [
  { id: PINNED, name: "Space One", isDefault: true },
  { id: OTHER, name: "Space Two" },
];

const configHome = useTempConfigHome("appstrate-cli-agents-cfg-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalDataHome = process.env.XDG_DATA_HOME;

let home: string;
let dataHome: string;

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  home = await mkdtemp(join(tmpdir(), "appstrate-cli-agents-home-"));
  dataHome = await mkdtemp(join(tmpdir(), "appstrate-cli-agents-data-"));
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = dataHome;
  await seedLoggedInProfile("default", { orgId: "org_1", spaceId: PINNED });
});

afterEach(async () => {
  keyring.restore();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  await configHome.teardown();
  await rm(home, { recursive: true, force: true });
  await rm(dataHome, { recursive: true, force: true });
});

const pluginRoot = (): string => join(getDataDir(), "claude-plugin");
const pluginSkills = (): string => join(pluginRoot(), "skills");
const commandFile = (slug: string, file = "SKILL.md"): string => join(pluginSkills(), slug, file);

const SKILLS: SkillFixture[] = [{ id: "@acme/pdf-tools", skillMd: skillMd("pdf-tools") }];

const REPORT: AgentFixture = {
  id: "@acme/report",
  display_name: "Weekly report",
  description: "Writes the weekly report.",
  input: {
    schema: {
      type: "object",
      properties: { topic: { type: "string" }, account: { type: "string" } },
    },
  },
  values: { account: "acct_1" },
};

function serve(
  agents: AgentFixture[],
  options: { skills?: SkillFixture[]; spaces?: SpaceFixture[] } = {},
) {
  const server = createSkillServer(options.skills ?? SKILLS, options.spaces ?? SPACES, agents);
  server.install();
  return server;
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else out[rel] = await readText(join(dir, entry.name));
    }
  };
  await walk(root, "");
  return out;
}

async function ledgerVersion(slug: string): Promise<string | undefined> {
  const state = JSON.parse(await readText(getStatePath())) as {
    targets: Record<string, { managed: Record<string, { version: string }> }>;
  };
  return state.targets["claude-plugin"]?.managed[slug]?.version;
}

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe("packages sync — agent commands in the plugin", () => {
  it("writes each active agent as skills/run-<name>/{SKILL.md,input.json}", async () => {
    serve([REPORT]);
    const { io, stderr } = createMemoryIO();

    await packagesSyncCommand({}, io);

    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-report"]);
    expect((await readdir(join(pluginSkills(), "run-report"))).sort()).toEqual([
      "SKILL.md",
      "input.json",
    ]);
    expect(await readText(commandFile("run-report"))).toContain("name: run-report");
    expect(await ledgerVersion("run-report")).toBe("1.0.0");
    expect(stderr()).toBe("");
  });

  it("shows agent commands in a dry run and writes nothing", async () => {
    serve([REPORT]);
    const { io, stdout } = createMemoryIO();

    await packagesSyncCommand({ dryRun: true }, io);

    expect(stdout()).toContain("  + run-report\n");
    expect(await exists(pluginRoot())).toBe(false);
  });

  it("never writes an agent to codex or claude-user, and lists none for them", async () => {
    const server = serve([REPORT]);

    await packagesSyncCommand({ target: ["codex", "claude-user"] }, createMemoryIO().io);

    expect(await readdir(join(home, ".agents", "skills"))).toEqual(["pdf-tools"]);
    expect(await readdir(join(home, ".claude", "skills"))).toEqual(["pdf-tools"]);
    expect(server.agentReads()).toBe(0);
  });

  it("keeps a shared target free of agents when it syncs beside the plugin", async () => {
    serve([REPORT]);

    await packagesSyncCommand({ target: ["claude-plugin", "codex"] }, createMemoryIO().io);

    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-report"]);
    expect(await readdir(join(home, ".agents", "skills"))).toEqual(["pdf-tools"]);
  });

  it("leaves the plugin untouched when nothing changed", async () => {
    const server = serve([REPORT]);
    await packagesSyncCommand({}, createMemoryIO().io);
    const before = await snapshot(pluginRoot());
    const command = await lstat(commandFile("run-report"));

    await packagesSyncCommand({}, createMemoryIO().io);

    expect(await snapshot(pluginRoot())).toEqual(before);
    // Same inode: the tree was not rebuilt, so the plugin's hash cannot move.
    expect((await lstat(commandFile("run-report"))).ino).toBe(command.ino);
    expect(server.downloads()).toBe(1);
  });

  it("rewrites the command when a newer version is published", async () => {
    serve([REPORT]);
    await packagesSyncCommand({}, createMemoryIO().io);
    const before = await readText(commandFile("run-report"));

    serve([{ ...REPORT, versions: ["1.0.0", "1.1.0"] }]);
    await packagesSyncCommand({}, createMemoryIO().io);

    expect(await readText(commandFile("run-report"))).not.toBe(before);
    expect(await readText(commandFile("run-report"))).toContain("1.1.0");
    expect(await ledgerVersion("run-report")).toBe("1.1.0");
  });

  it("rewrites the command when the space locks another field", async () => {
    serve([REPORT]);
    await packagesSyncCommand({}, createMemoryIO().io);
    const before = await readText(commandFile("run-report", "input.json"));

    serve([{ ...REPORT, locked_fields: ["account"] }]);
    await packagesSyncCommand({}, createMemoryIO().io);

    expect(await readText(commandFile("run-report", "input.json"))).not.toBe(before);
  });

  it("removes an agent that is no longer active in the pinned space", async () => {
    serve([REPORT]);
    await packagesSyncCommand({}, createMemoryIO().io);

    serve([{ ...REPORT, activeIn: [] }]);
    await packagesSyncCommand({}, createMemoryIO().io);

    expect(await readdir(pluginSkills())).toEqual(["pdf-tools"]);
    expect(await ledgerVersion("run-report")).toBeUndefined();
  });

  it("preserves the installation and ledger when the agent listing fails", async () => {
    serve([REPORT]);
    await packagesSyncCommand({}, createMemoryIO().io);
    const before = await snapshot(pluginRoot());
    const ledger = await readText(getStatePath());
    // The listing is the catalogue: a 500 there says nothing about which agents left.
    const serveRest = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/agents"
        ? Response.json({ message: "Unavailable" }, { status: 500 })
        : serveRest(input, init)) as typeof fetch;
    const { io, stdout } = createMemoryIO();

    await expect(packagesSyncCommand({ printPath: true }, io)).rejects.toBeInstanceOf(ExitError);

    expect(stdout()).toBe("");
    expect(await snapshot(pluginRoot())).toEqual(before);
    expect(await readText(getStatePath())).toBe(ledger);
  });

  it("keeps the installed command when its detail read fails transiently", async () => {
    serve([REPORT]);
    await packagesSyncCommand({}, createMemoryIO().io);
    const before = await readText(commandFile("run-report"));

    serve([{ ...REPORT, detailError: 500 }]);
    const { io, stdout, stderr } = createMemoryIO();
    await packagesSyncCommand({ printPath: true }, io);

    expect(stdout()).toBe(`${pluginRoot()}\n`);
    expect(stderr()).toContain("Skipped @acme/report");
    expect(await readText(commandFile("run-report"))).toBe(before);
    expect(await ledgerVersion("run-report")).toBe("1.0.0");
  });

  it("removes an installed command that can no longer be rendered, and says why", async () => {
    serve([REPORT]);
    await packagesSyncCommand({}, createMemoryIO().io);

    // Deterministic, unlike a 500: keeping the old command would keep it forever.
    serve([{ ...REPORT, versions: ["1.0.0", "not-a-version"] }]);
    const { io, stdout, stderr } = createMemoryIO();
    await packagesSyncCommand({ printPath: true }, io);

    expect(stdout()).toBe(`${pluginRoot()}\n`);
    expect(stderr()).toContain("Skipped @acme/report");
    expect(await readdir(pluginSkills())).toEqual(["pdf-tools"]);
    expect(await ledgerVersion("run-report")).toBeUndefined();
  });

  it("switches a shared target's context although an agent command is unresolved", async () => {
    serve([REPORT]);
    await packagesSyncCommand({ target: ["claude-plugin", "codex"] }, createMemoryIO().io);
    // The plugin moves to the new login alone; codex still holds the old one.
    await seedLoggedInProfile("default", { orgId: "org_1", spaceId: PINNED, userId: "u_2" });
    await packagesSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    serve([{ ...REPORT, detailError: 500 }]);
    const { io, stdout } = createMemoryIO();
    await packagesSyncCommand({ target: ["claude-plugin", "codex"], printPath: true }, io);

    expect(stdout()).toBe(`${pluginRoot()}\n`);
    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { context: { userId: string } }>;
    };
    expect(state.targets.codex?.context.userId).toBe("u_2");
    expect(await readdir(join(home, ".agents", "skills"))).toEqual(["pdf-tools"]);
    expect(await exists(commandFile("run-report"))).toBe(true);
  });
});

describe("packages sync — agents come from the pinned space only (D19)", () => {
  const ELSEWHERE: AgentFixture = {
    id: "@acme/triage",
    description: "Triage.",
    activeIn: [OTHER],
  };

  it("replaces the agent set on a space switch and leaves the skills alone", async () => {
    const server = serve([{ ...REPORT, activeIn: [PINNED] }, ELSEWHERE]);
    await packagesSyncCommand({}, createMemoryIO().io);
    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-report"]);
    const skill = await readText(commandFile("pdf-tools"));

    await seedLoggedInProfile("default", { orgId: "org_1", spaceId: OTHER });
    await packagesSyncCommand({}, createMemoryIO().io);

    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-triage"]);
    expect(await readText(commandFile("pdf-tools"))).toBe(skill);
    expect(server.downloads()).toBe(1);
  });

  it("installs the pinned space's agents whatever --space selects for skills", async () => {
    serve([{ ...REPORT, activeIn: [PINNED] }, ELSEWHERE]);

    await packagesSyncCommand({ space: [OTHER] }, createMemoryIO().io);

    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-report"]);
  });

  const withRole = (permissions: string[]): SpaceFixture[] => [
    {
      id: PINNED,
      name: "Space One",
      isDefault: true,
      permissions: [...permissions, "skills:read"],
    },
  ];

  // The MCP server's own gate on `run_and_wait`: dispatch, launch AND read back.
  for (const [role, permissions] of [
    ["a runner (no agents:read)", ["agents:run", "runs:read", "mcp:invoke"]],
    ["runs:read-all", ["agents:run", "runs:read-all", "mcp:invoke"]],
  ] as const) {
    it(`installs agent commands for ${role}`, async () => {
      serve([REPORT], { spaces: withRole([...permissions]) });
      const { io, stderr } = createMemoryIO();

      await packagesSyncCommand({ printPath: true }, io);

      expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-report"]);
      expect(stderr()).not.toContain("Agent commands not synced");
    });
  }

  for (const [role, permissions] of [
    ["no runs read", ["agents:read", "agents:run", "mcp:invoke"]],
    ["no agents:run", ["agents:read", "runs:read", "mcp:invoke"]],
    ["no mcp:invoke", ["agents:run", "runs:read"]],
  ] as const) {
    it(`syncs no agent, with one note naming the space, for a role with ${role}`, async () => {
      const server = serve([REPORT], { spaces: withRole([...permissions]) });
      const { io, stderr } = createMemoryIO();

      await packagesSyncCommand({ printPath: true }, io);

      expect(await readdir(pluginSkills())).toEqual(["pdf-tools"]);
      expect(occurrences(stderr(), "Agent commands not synced")).toBe(1);
      expect(stderr()).toContain('pinned space "Space One"');
      expect(stderr()).toContain("needs agents:run, runs:read and mcp:invoke");
      expect(server.agentReads()).toBe(0);
    });
  }

  it("says nothing more than the dead-pin warning when the pin itself is gone", async () => {
    serve([REPORT], {
      spaces: [
        { id: PINNED, name: "Space One", isDefault: true, access: "none" },
        { id: OTHER, name: "Space Two" },
      ],
    });
    const { io, stderr } = createMemoryIO();

    await packagesSyncCommand({ printPath: true }, io);

    expect(stderr()).toContain(`Pinned space "${PINNED}" is not accessible`);
    expect(stderr()).not.toContain("Agent commands not synced");
    expect(await readdir(pluginSkills())).toEqual(["pdf-tools"]);
  });
});

describe("packages sync — agents under --source draft", () => {
  it("pins the draft, and resolves a system agent — which has none — published", async () => {
    serve([REPORT, { id: "@appstrate/assistant", description: "Helps.", source: "system" }]);

    await packagesSyncCommand({ source: "draft" }, createMemoryIO().io);

    expect(await ledgerVersion("run-report")).toBe("draft");
    expect(await ledgerVersion("run-assistant")).toBe("1.0.0");
  });

  it("skips an agent the caller may not write, saying whose copy it is", async () => {
    serve([{ ...REPORT, draft: { notWritable: true } }]);
    const { io, stderr } = createMemoryIO();

    await packagesSyncCommand({ source: "draft", printPath: true }, io);

    expect(stderr()).toContain("Skipped @acme/report");
    expect(stderr()).toContain("author's working copy");
    expect(await exists(join(pluginSkills(), "run-report"))).toBe(false);
  });

  it("words a skipped system agent by the selector it was read with", async () => {
    serve([{ id: "@appstrate/assistant", source: "system", detailError: 404 }]);
    const { io, stderr } = createMemoryIO();

    await packagesSyncCommand({ source: "draft", printPath: true }, io);

    expect(stderr()).toContain("Skipped @appstrate/assistant: no published version available.");
  });
});

describe("packages sync — agent command names (D23)", () => {
  it("gives a skill its name and the agent of the same name the run- prefix", async () => {
    serve([{ ...REPORT, id: "@team/pdf-tools" }]);

    await packagesSyncCommand({}, createMemoryIO().io);

    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-pdf-tools"]);
  });

  it("falls back to run-<scope>-<name> when a skill already holds run-<name>", async () => {
    serve([{ ...REPORT, id: "@team/pdf-tools" }], {
      skills: [
        { id: "@acme/pdf-tools", skillMd: skillMd("pdf-tools") },
        { id: "@acme/wrapper", skillMd: skillMd("run-pdf-tools") },
      ],
    });
    const { io, stderr } = createMemoryIO();

    await packagesSyncCommand({}, io);

    expect((await readdir(pluginSkills())).sort()).toEqual([
      "pdf-tools",
      "run-pdf-tools",
      "run-team-pdf-tools",
    ]);
    expect(await readText(commandFile("run-pdf-tools"))).toBe(skillMd("run-pdf-tools"));
    expect(stderr()).toContain(
      'Renamed @team/pdf-tools to "run-team-pdf-tools" — "run-pdf-tools" is already taken.',
    );
  });
});

describe("packages sync — stored values stay on the server (D20)", () => {
  it("never writes a stored input value anywhere under the plugin", async () => {
    const LOCKED = "SENTINEL-locked-7f3a";
    const PREFILLED = "SENTINEL-prefilled-91c2";
    serve([
      {
        ...REPORT,
        values: { account: LOCKED, topic: PREFILLED },
        locked_fields: ["account"],
      },
    ]);

    await packagesSyncCommand({}, createMemoryIO().io);

    const files = await snapshot(pluginRoot());
    expect(Object.keys(files)).toContain("skills/run-report/input.json");
    for (const [path, text] of Object.entries(files)) {
      expect({ path, locked: text.includes(LOCKED) }).toEqual({ path, locked: false });
      expect({ path, prefilled: text.includes(PREFILLED) }).toEqual({ path, prefilled: false });
    }
  });
});
