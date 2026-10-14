// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate code sync` — agent commands (issue #1268, D18–D25).
 *
 * Same harness as `code-sync-command.test.ts`: the command is called
 * directly with a per-test `createMemoryIO()` sink, throw-away config / data /
 * `HOME` directories, and the shared stub server serving skills AND agents.
 * What is asserted here is the wiring: which spaces the agents come from, which
 * target receives them, when a command is rewritten, and what never reaches
 * the disk.
 */

import { describe, it, expect } from "bun:test";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codeSyncCommand } from "../src/commands/code-sync.ts";
import { getStatePath } from "../src/lib/skills-sync/state.ts";
import { seedLoggedInProfile } from "./helpers/auth-fixture.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { CommandExit } from "../src/lib/io.ts";
import {
  createSkillServer,
  skillMd,
  type AgentFixture,
  type SkillFixture,
  type SpaceFixture,
} from "./helpers/skills-server.ts";
import { exists, pluginRoot, readText, snapshot, useSyncHarness } from "./helpers/sync-harness.ts";

// Platform-shaped: the command writes the space id, and refuses any other shape.
const ONE = "spc_00000000-0000-4000-8000-000000000001";
const TWO = "spc_00000000-0000-4000-8000-000000000002";
const SPACES: SpaceFixture[] = [
  { id: ONE, name: "Space One", isDefault: true },
  { id: TWO, name: "Space Two" },
];

// The profile's pinned space is the REST default only: `code sync` never reads it.
const harness = useSyncHarness("appstrate-cli-agents", ONE);
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
  activeIn: [ONE],
};

function serve(
  agents: AgentFixture[],
  options: { skills?: SkillFixture[]; spaces?: SpaceFixture[] } = {},
) {
  const server = createSkillServer(options.skills ?? SKILLS, options.spaces ?? SPACES, agents);
  server.install();
  return server;
}

async function ledgerVersion(slug: string): Promise<string | undefined> {
  const state = JSON.parse(await readText(getStatePath())) as {
    targets: Record<string, { managed: Record<string, { version: string }> }>;
  };
  return state.targets["claude-plugin"]?.managed[slug]?.version;
}

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe("code sync — agent commands in the plugin", () => {
  it("writes each active agent as skills/run-<name>/{SKILL.md,input.json}", async () => {
    serve([REPORT]);
    const { io, stderr } = createMemoryIO();

    await codeSyncCommand({ target: ["claude-plugin"] }, io);

    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-report"]);
    expect((await readdir(join(pluginSkills(), "run-report"))).sort()).toEqual([
      "SKILL.md",
      "input.json",
    ]);
    expect(await readText(commandFile("run-report"))).toContain("name: run-report");
    // The plugin's MCP URL reaches every space, so the launch names this one.
    expect(await readText(commandFile("run-report"))).toContain(`"space_id":"${ONE}"`);
    expect(await ledgerVersion("run-report")).toBe("1.0.0");
    expect(stderr()).toBe("");
  });

  it("never writes an agent to codex or claude-user, and lists none for them", async () => {
    const server = serve([REPORT]);

    await codeSyncCommand({ target: ["codex", "claude-user"] }, createMemoryIO().io);

    expect(await readdir(join(harness.home(), ".agents", "skills"))).toEqual(["pdf-tools"]);
    expect(await readdir(join(harness.home(), ".claude", "skills"))).toEqual(["pdf-tools"]);
    expect(server.agentReads()).toBe(0);
  });

  it("keeps a shared target free of agents when it syncs beside the plugin", async () => {
    serve([REPORT]);

    await codeSyncCommand({ target: ["claude-plugin", "codex"] }, createMemoryIO().io);

    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-report"]);
    expect(await readdir(join(harness.home(), ".agents", "skills"))).toEqual(["pdf-tools"]);
  });

  it("leaves the plugin untouched when nothing changed", async () => {
    const server = serve([REPORT]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);
    const before = await snapshot(pluginRoot());
    const command = await lstat(commandFile("run-report"));

    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    expect(await snapshot(pluginRoot())).toEqual(before);
    // Same inode: the tree was not rebuilt, so the plugin's hash cannot move.
    expect((await lstat(commandFile("run-report"))).ino).toBe(command.ino);
    expect(server.downloads()).toBe(1);
  });

  it("rewrites the command when a newer version is published", async () => {
    serve([REPORT]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);
    const before = await readText(commandFile("run-report"));

    serve([{ ...REPORT, versions: ["1.0.0", "1.1.0"] }]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    expect(await readText(commandFile("run-report"))).not.toBe(before);
    expect(await readText(commandFile("run-report"))).toContain("1.1.0");
    expect(await ledgerVersion("run-report")).toBe("1.1.0");
  });

  it("rewrites the command when the space locks another field", async () => {
    serve([REPORT]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);
    const before = await readText(commandFile("run-report", "input.json"));

    serve([{ ...REPORT, locked_fields: ["account"] }]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    expect(await readText(commandFile("run-report", "input.json"))).not.toBe(before);
  });

  it("removes an agent that is no longer active in any selected space", async () => {
    serve([REPORT]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    serve([{ ...REPORT, activeIn: [] }]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    expect(await readdir(pluginSkills())).toEqual(["pdf-tools"]);
    expect(await ledgerVersion("run-report")).toBeUndefined();
  });

  it("preserves the installation and ledger when the agent listing fails", async () => {
    serve([REPORT]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);
    const before = await snapshot(pluginRoot());
    const ledger = await readText(getStatePath());
    // The listing is the catalogue: a 500 there says nothing about which agents left.
    const serveRest = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/agents"
        ? Response.json({ message: "Unavailable" }, { status: 500 })
        : serveRest(input, init)) as typeof fetch;
    const { io, stdout } = createMemoryIO();

    await expect(
      codeSyncCommand({ target: ["claude-plugin"], printPath: true }, io),
    ).rejects.toBeInstanceOf(CommandExit);

    expect(stdout()).toBe("");
    expect(await snapshot(pluginRoot())).toEqual(before);
    expect(await readText(getStatePath())).toBe(ledger);
  });

  it("keeps the installed command when its detail read fails transiently", async () => {
    serve([REPORT]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);
    const before = await readText(commandFile("run-report"));

    serve([{ ...REPORT, detailError: 500 }]);
    const { io, stdout, stderr } = createMemoryIO();
    await codeSyncCommand({ target: ["claude-plugin"], printPath: true }, io);

    expect(stdout()).toBe(`${pluginRoot()}\n`);
    expect(stderr()).toContain("Skipped @acme/report");
    expect(await readText(commandFile("run-report"))).toBe(before);
    expect(await ledgerVersion("run-report")).toBe("1.0.0");
  });

  it("removes an installed command that can no longer be rendered, and says why", async () => {
    serve([REPORT]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    // Deterministic, unlike a 500: keeping the old command would keep it forever.
    serve([{ ...REPORT, versions: ["1.0.0", "not-a-version"] }]);
    const { io, stdout, stderr } = createMemoryIO();
    await codeSyncCommand({ target: ["claude-plugin"], printPath: true }, io);

    expect(stdout()).toBe(`${pluginRoot()}\n`);
    expect(stderr()).toContain("Skipped @acme/report");
    expect(await readdir(pluginSkills())).toEqual(["pdf-tools"]);
    expect(await ledgerVersion("run-report")).toBeUndefined();
  });

  it("switches a shared target's context although an agent command is unresolved", async () => {
    serve([REPORT]);
    await codeSyncCommand({ target: ["claude-plugin", "codex"] }, createMemoryIO().io);
    // The plugin moves to the new login alone; codex still holds the old one.
    await seedLoggedInProfile("default", { orgId: "org_1", spaceId: ONE, userId: "u_2" });
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    serve([{ ...REPORT, detailError: 500 }]);
    const { io, stdout } = createMemoryIO();
    await codeSyncCommand({ target: ["claude-plugin", "codex"], printPath: true }, io);

    expect(stdout()).toBe(`${pluginRoot()}\n`);
    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { context: { userId: string } }>;
    };
    expect(state.targets.codex?.context.userId).toBe("u_2");
    expect(await readdir(join(harness.home(), ".agents", "skills"))).toEqual(["pdf-tools"]);
    expect(await exists(commandFile("run-report"))).toBe(true);
  });
});

describe("code sync — agents come from the selected spaces (#1972)", () => {
  const TRIAGE: AgentFixture = { id: "@acme/triage", description: "Triage.", activeIn: [TWO] };
  const spaceOf = async (slug: string): Promise<string | undefined> =>
    /"space_id":"([^"]+)"/.exec(await readText(commandFile(slug)))?.[1];

  it("syncs the agents of every selected space, each launching in its own", async () => {
    serve([REPORT, TRIAGE]);

    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    expect((await readdir(pluginSkills())).sort()).toEqual([
      "pdf-tools",
      "run-report",
      "run-triage",
    ]);
    expect(await spaceOf("run-report")).toBe(ONE);
    expect(await spaceOf("run-triage")).toBe(TWO);
  });

  it("installs one command per space for an agent active in two", async () => {
    serve([{ ...REPORT, activeIn: [ONE, TWO] }]);
    const { io, stderr } = createMemoryIO();

    await codeSyncCommand({ target: ["claude-plugin"] }, io);

    expect(await spaceOf("run-report")).toBe(ONE);
    expect(await spaceOf("run-space-two-report")).toBe(TWO);
    expect(stderr()).toContain(
      'Renamed @acme/report in space "Space Two" to "run-space-two-report" — "run-report" is already taken.',
    );
  });

  for (const [first, second, newcomer] of [
    [ONE, TWO, "run-space-two-report"],
    [TWO, ONE, "run-space-one-report"],
  ] as const) {
    it(`keeps run-<name> with its space when the agent is activated in another (${first === ONE ? "after" : "before"} it)`, async () => {
      serve([{ ...REPORT, activeIn: [first] }]);
      await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);
      expect(await spaceOf("run-report")).toBe(first);

      serve([{ ...REPORT, activeIn: [ONE, TWO] }]);
      await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

      expect(await spaceOf("run-report")).toBe(first);
      expect(await spaceOf(newcomer)).toBe(second);
    });
  }

  // A name that frees up may have launched the same agent in another space:
  // handing it over would silently move `/appstrate:run-<name>` to another space.
  it("keeps run-<space>-<name> when the space holding run-<name> leaves the selection", async () => {
    serve([{ ...REPORT, activeIn: [ONE, TWO] }]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    const { io, stderr } = createMemoryIO();
    await codeSyncCommand({ target: ["claude-plugin"], space: [TWO] }, io);

    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-space-two-report"]);
    expect(await spaceOf("run-space-two-report")).toBe(TWO);
    expect(stderr()).not.toContain("Renamed");
  });

  it("keeps run-<name> when the other space leaves the selection", async () => {
    serve([{ ...REPORT, activeIn: [ONE, TWO] }]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    await codeSyncCommand({ target: ["claude-plugin"], space: [ONE] }, createMemoryIO().io);

    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-report"]);
    expect(await spaceOf("run-report")).toBe(ONE);
  });

  it("narrows agents with --space exactly as it narrows skills", async () => {
    serve([REPORT, TRIAGE]);

    await codeSyncCommand({ target: ["claude-plugin"], space: [TWO] }, createMemoryIO().io);

    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-triage"]);
  });

  it("needs no pinned space", async () => {
    serve([REPORT, TRIAGE]);
    await seedLoggedInProfile("default", { orgId: "org_1" });
    const { io, stdout } = createMemoryIO();

    await codeSyncCommand({ target: ["claude-plugin"], printPath: true }, io);

    expect(stdout()).toBe(`${pluginRoot()}\n`);
    expect((await readdir(pluginSkills())).sort()).toEqual([
      "pdf-tools",
      "run-report",
      "run-triage",
    ]);
  });

  it("keeps the other space's command when one space's read fails", async () => {
    serve([{ ...REPORT, activeIn: [ONE, TWO] }]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);
    const second = await readText(commandFile("run-space-two-report"));

    // Space One no longer offers it; Space Two's detail read fails transiently.
    serve([{ ...REPORT, activeIn: [TWO] }]);
    const serveRest = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname.startsWith("/api/packages/agents/") &&
      new Headers(init?.headers).get("X-Space-Id") === TWO
        ? Response.json({ message: "Unavailable" }, { status: 500 })
        : serveRest(input, init)) as typeof fetch;
    const { io, stderr } = createMemoryIO();
    await codeSyncCommand({ target: ["claude-plugin"], printPath: true }, io);

    expect(stderr()).toContain('Skipped @acme/report in space "Space Two"');
    expect(await exists(commandFile("run-report"))).toBe(false);
    expect(await readText(commandFile("run-space-two-report"))).toBe(second);
  });

  const withRoles = (one: string[], two: string[]): SpaceFixture[] => [
    { id: ONE, name: "Space One", isDefault: true, permissions: [...one, "skills:read"] },
    { id: TWO, name: "Space Two", permissions: [...two, "skills:read"] },
  ];
  const RUNNER = ["agents:run", "runs:read", "mcp:invoke"];

  // The MCP server's own gate on `run_and_wait`: dispatch, launch AND read back.
  for (const [role, permissions] of [
    ["a runner (no agents:read)", RUNNER],
    ["runs:read-all", ["agents:run", "runs:read-all", "mcp:invoke"]],
  ] as const) {
    it(`installs agent commands for ${role}`, async () => {
      serve([REPORT], { spaces: withRoles([...permissions], [...permissions]) });
      const { io, stderr } = createMemoryIO();

      await codeSyncCommand({ target: ["claude-plugin"], printPath: true }, io);

      expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-report"]);
      expect(stderr()).not.toContain("Agent commands not synced");
    });
  }

  for (const [role, permissions] of [
    ["no runs read", ["agents:read", "agents:run", "mcp:invoke"]],
    ["no agents:run", ["agents:read", "runs:read", "mcp:invoke"]],
    ["no mcp:invoke", ["agents:run", "runs:read"]],
  ] as const) {
    it(`syncs no agent from a space where the role has ${role}, and says so once`, async () => {
      serve([REPORT, TRIAGE], { spaces: withRoles([...permissions], RUNNER) });
      const { io, stderr } = createMemoryIO();

      await codeSyncCommand({ target: ["claude-plugin"], printPath: true }, io);

      expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-triage"]);
      expect(occurrences(stderr(), "Agent commands not synced")).toBe(1);
      expect(stderr()).toContain('Agent commands not synced from space "Space One"');
      expect(stderr()).toContain("needs agents:run, runs:read and mcp:invoke");
    });
  }

  it("names every space it skips in one note, and lists no agent there", async () => {
    const server = serve([REPORT, TRIAGE], { spaces: withRoles([], []) });
    const { io, stderr } = createMemoryIO();

    await codeSyncCommand({ target: ["claude-plugin"], printPath: true }, io);

    expect(await readdir(pluginSkills())).toEqual(["pdf-tools"]);
    expect(occurrences(stderr(), "Agent commands not synced")).toBe(1);
    expect(stderr()).toContain('from space "Space One", space "Space Two":');
    expect(server.agentReads()).toBe(0);
  });

  it("says nothing about agents to a target that carries none", async () => {
    serve([REPORT], { spaces: withRoles([], []) });
    const { io, stderr } = createMemoryIO();

    await codeSyncCommand({ target: ["codex"] }, io);

    expect(stderr()).not.toContain("Agent commands not synced");
  });
});

describe("code sync — a ledger written before agents recorded their space", () => {
  const stripSpaces = async (): Promise<void> => {
    // The shape the previous CLI wrote: no `spaceId` on any entry.
    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { managed: Record<string, { spaceId?: string }> }>;
    };
    for (const target of Object.values(state.targets)) {
      for (const entry of Object.values(target.managed)) delete entry.spaceId;
    }
    await writeFile(getStatePath(), JSON.stringify(state));
  };

  // Accepted limitation (#1972): an entry without a space claims no name on the
  // upgrade run, so selection order decides, not the space it was synced from.
  it("gives run-<name> to the first selected space on the upgrade run, then keeps it", async () => {
    serve([{ ...REPORT, activeIn: [TWO] }]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);
    await stripSpaces();

    serve([{ ...REPORT, activeIn: [ONE, TWO] }]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    const spaceOf = async (slug: string) =>
      /"space_id":"([^"]+)"/.exec(await readText(commandFile(slug)))?.[1];
    expect(await spaceOf("run-report")).toBe(ONE);
    expect(await spaceOf("run-space-two-report")).toBe(TWO);

    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);
    expect(await spaceOf("run-report")).toBe(ONE);
  });

  it("keeps every skill and re-renders the agent commands once, under the same names", async () => {
    const server = serve([REPORT]);
    await codeSyncCommand({ target: ["claude-plugin", "codex"] }, createMemoryIO().io);
    const command = await readText(commandFile("run-report"));
    await stripSpaces();
    const agentFile = await lstat(commandFile("run-report"));
    const { io, stderr } = createMemoryIO();

    await codeSyncCommand({ target: ["claude-plugin", "codex"] }, io);

    expect(stderr()).toBe("");
    expect(server.downloads()).toBe(1); // the first run's, shared by both targets
    expect(await readdir(join(harness.home(), ".agents", "skills"))).toEqual(["pdf-tools"]);
    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-report"]);
    expect(await readText(commandFile("run-report"))).toBe(command);
    // Rewritten, not carried: the entry is rendered again and records its space.
    expect((await lstat(commandFile("run-report"))).ino).not.toBe(agentFile.ino);
    const after = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { managed: Record<string, { spaceId?: string }> }>;
    };
    expect(after.targets["claude-plugin"]?.managed["run-report"]?.spaceId).toBe(ONE);
    expect(after.targets["claude-plugin"]?.managed["pdf-tools"]?.spaceId).toBeUndefined();
  });
});

describe("code sync — agents under --source draft", () => {
  it("pins the draft, and resolves a system agent — which has none — published", async () => {
    serve([REPORT, { id: "@appstrate/assistant", description: "Helps.", source: "system" }]);

    await codeSyncCommand({ target: ["claude-plugin"], source: "draft" }, createMemoryIO().io);

    expect(await ledgerVersion("run-report")).toBe("draft");
    expect(await ledgerVersion("run-assistant")).toBe("1.0.0");
  });

  it("lets a context switch through when a draft is refused, removing it", async () => {
    serve([REPORT]);
    await codeSyncCommand({ target: ["claude-plugin"], source: "draft" }, createMemoryIO().io);
    expect(await ledgerVersion("run-report")).toBe("draft");

    // A refusal is authority, not chance: it must not hold the old context forever.
    await seedLoggedInProfile("default", { orgId: "org_1", spaceId: ONE, userId: "u_2" });
    serve([{ ...REPORT, draft: { notWritable: true } }]);
    const { io, stdout, stderr } = createMemoryIO();
    await codeSyncCommand({ target: ["claude-plugin"], source: "draft", printPath: true }, io);

    expect(stdout()).toBe(`${pluginRoot()}\n`);
    expect(stderr()).toContain("author's working copy");
    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { context: { userId: string } }>;
    };
    expect(state.targets["claude-plugin"]?.context.userId).toBe("u_2");
    expect(await exists(commandFile("run-report"))).toBe(false);
  });

  it("words a skipped system agent by the selector it was read with", async () => {
    serve([{ id: "@appstrate/assistant", source: "system", detailError: 404 }]);
    const { io, stderr } = createMemoryIO();

    await codeSyncCommand({ target: ["claude-plugin"], source: "draft", printPath: true }, io);

    expect(stderr()).toContain(
      'Skipped @appstrate/assistant in space "Space One": no published version available.',
    );
  });
});

describe("code sync — agent command names (D23)", () => {
  it("falls back to run-<scope>-<name> when a skill already holds run-<name>", async () => {
    serve([{ ...REPORT, id: "@team/pdf-tools" }], {
      skills: [
        { id: "@acme/pdf-tools", skillMd: skillMd("pdf-tools") },
        { id: "@acme/wrapper", skillMd: skillMd("run-pdf-tools") },
      ],
    });
    const { io, stderr } = createMemoryIO();

    await codeSyncCommand({ target: ["claude-plugin"] }, io);

    expect((await readdir(pluginSkills())).sort()).toEqual([
      "pdf-tools",
      "run-pdf-tools",
      "run-team-pdf-tools",
    ]);
    expect(await readText(commandFile("run-pdf-tools"))).toBe(skillMd("run-pdf-tools"));
    expect(stderr()).toContain(
      'Renamed @team/pdf-tools in space "Space One" to "run-team-pdf-tools" — "run-pdf-tools" is already taken.',
    );
  });
});

describe("code sync — an installed name stays with its package", () => {
  it("never hands an agent's command to a newcomer that sorts first", async () => {
    const zeta: AgentFixture = { ...REPORT, id: "@zeta/report", description: "Zeta." };
    const alpha: AgentFixture = { ...REPORT, id: "@alpha/report", description: "Alpha." };
    serve([zeta]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    serve([alpha, zeta]);
    const { io, stderr } = createMemoryIO();
    await codeSyncCommand({ target: ["claude-plugin"] }, io);

    expect(await readText(commandFile("run-report"))).toContain("@zeta/report");
    expect(await readText(commandFile("run-alpha-report"))).toContain("@alpha/report");
    expect(stderr()).toContain('Renamed @alpha/report in space "Space One" to "run-alpha-report"');

    // Keeping the fallback it already holds is not news.
    const again = createMemoryIO();
    await codeSyncCommand({ target: ["claude-plugin"] }, again.io);
    expect(again.stderr()).not.toContain("Renamed");

    // Once the incumbent leaves, the newcomer keeps the command it has.
    serve([alpha]);
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    expect((await readdir(pluginSkills())).sort()).toEqual(["pdf-tools", "run-alpha-report"]);
    expect(await readText(commandFile("run-alpha-report"))).toContain("@alpha/report");
  });

  it("settles two disagreeing ledgers by target order, the plugin first", async () => {
    const zeta: SkillFixture = { id: "@zeta/report", skillMd: skillMd("report", "Zeta.") };
    const alpha: SkillFixture = { id: "@alpha/report", skillMd: skillMd("report", "Alpha.") };
    // codex records `report` for zeta, the plugin records it for alpha.
    serve([], { skills: [zeta] });
    await codeSyncCommand({ target: ["codex"] }, createMemoryIO().io);
    serve([], { skills: [alpha] });
    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    serve([], { skills: [alpha, zeta] });
    await codeSyncCommand({ target: ["codex", "claude-plugin"] }, createMemoryIO().io);

    const codex = join(harness.home(), ".agents", "skills");
    expect(await readText(commandFile("report"))).toContain("Alpha.");
    expect(await readText(commandFile("zeta-report"))).toContain("Zeta.");
    expect(await readText(join(codex, "report", "SKILL.md"))).toContain("Alpha.");
    expect(await readText(join(codex, "zeta-report", "SKILL.md"))).toContain("Zeta.");
  });
});

describe("code sync — stored values stay on the server (D20)", () => {
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

    await codeSyncCommand({ target: ["claude-plugin"] }, createMemoryIO().io);

    const files = await snapshot(pluginRoot());
    expect(Object.keys(files)).toContain("skills/run-report/input.json");
    for (const [path, text] of Object.entries(files)) {
      expect({ path, locked: text.includes(LOCKED) }).toEqual({ path, locked: false });
      expect({ path, prefilled: text.includes(PREFILLED) }).toEqual({ path, prefilled: false });
    }
  });
});
