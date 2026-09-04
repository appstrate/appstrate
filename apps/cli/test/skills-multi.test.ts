// SPDX-License-Identifier: Apache-2.0

/**
 * Two things the single-profile sync could not do: let two profiles (two
 * organizations, or two spaces of one) share a machine without deleting each
 * other's skills, and read the union of several spaces in one run.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillsSyncCommand } from "../src/commands/skills.ts";
import { getDataDir, updateProfile } from "../src/lib/config.ts";
import { getStatePath } from "../src/lib/skills-sync/state.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { ExitError } from "./helpers/process-exit.ts";
import { createSkillServer, skillMd, type SkillFixture } from "./helpers/skills-server.ts";

const configHome = useTempConfigHome("appstrate-cli-multi-cfg-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalDataHome = process.env.XDG_DATA_HOME;

let home: string;
let dataHome: string;

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  home = await mkdtemp(join(tmpdir(), "appstrate-cli-multi-home-"));
  dataHome = await mkdtemp(join(tmpdir(), "appstrate-cli-multi-data-"));
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = dataHome;
  // `default` is the marketplace profile; `tastet` is a second organization.
  await seedLoggedInProfile("default", { orgId: "org_1", spaceId: "spc_1" });
  await seedLoggedInProfile("tastet", { orgId: "org_2", spaceId: "spc_t" });
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

const codexRoot = (): string => join(home, ".agents", "skills");
const listCodex = async (): Promise<string[]> => (await readdir(codexRoot())).sort();
const readState = async (): Promise<{
  targets: Record<string, { managed: Record<string, unknown> }>;
}> => JSON.parse(await readFile(getStatePath(), "utf-8"));

const TRACTR: SkillFixture[] = [
  { id: "@tractr/drive", skillMd: skillMd("drive"), spaces: ["spc_1"] },
  { id: "@tractr/fathom", skillMd: skillMd("fathom"), spaces: ["spc_1"] },
];
const TASTET: SkillFixture[] = [
  { id: "@tastet/libro", skillMd: skillMd("libro"), spaces: ["spc_t"] },
];

describe("skills sync — two profiles on one machine", () => {
  it("keeps each profile's skills when the other one syncs", async () => {
    createSkillServer([...TRACTR, ...TASTET]).install();

    await skillsSyncCommand({ target: ["codex"] }, createMemoryIO().io);
    expect(await listCodex()).toEqual(["drive", "fathom"]);

    await skillsSyncCommand({ profile: "tastet", target: ["codex"] }, createMemoryIO().io);
    expect(await listCodex()).toEqual(["drive", "fathom", "libro"]);

    // Back to the first profile: `libro` is absent from ITS catalogue, and
    // that used to be a deletion.
    await skillsSyncCommand({ target: ["codex"] }, createMemoryIO().io);
    expect(await listCodex()).toEqual(["drive", "fathom", "libro"]);

    const state = await readState();
    expect(Object.keys(state.targets["default:codex"]!.managed).sort()).toEqual([
      "drive",
      "fathom",
    ]);
    expect(Object.keys(state.targets["tastet:codex"]!.managed)).toEqual(["libro"]);
  });

  it("still removes a skill that left its own profile's catalogue", async () => {
    createSkillServer([...TRACTR, ...TASTET]).install();
    await skillsSyncCommand({ target: ["codex"] }, createMemoryIO().io);
    await skillsSyncCommand({ profile: "tastet", target: ["codex"] }, createMemoryIO().io);

    createSkillServer([TRACTR[0]!, ...TASTET]).install();
    await skillsSyncCommand({ target: ["codex"] }, createMemoryIO().io);

    expect(await listCodex()).toEqual(["drive", "libro"]);
  });

  it("refuses, rather than replaces, a slug the other profile owns", async () => {
    createSkillServer([
      ...TRACTR,
      { id: "@tastet/drive", skillMd: skillMd("drive"), spaces: ["spc_t"] },
    ]).install();
    await skillsSyncCommand({ target: ["codex"] }, createMemoryIO().io);
    const { io, stderr } = createMemoryIO();

    await expect(
      skillsSyncCommand({ profile: "tastet", target: ["codex"] }, io),
    ).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toContain("Skipped @tastet/drive on codex");
    expect(await readFile(join(codexRoot(), "drive", "SKILL.md"), "utf-8")).toContain("# drive");
  });

  it("gives a non-default profile its own plugin tree", async () => {
    createSkillServer([...TRACTR, ...TASTET]).install();
    await skillsSyncCommand({ printPath: true }, createMemoryIO().io);
    const { io, stdout } = createMemoryIO();

    await skillsSyncCommand({ profile: "tastet", printPath: true }, io);

    expect(stdout()).toBe(`${join(getDataDir(), "claude-plugin-tastet")}\n`);
    expect((await readdir(join(getDataDir(), "claude-plugin", "skills"))).sort()).toEqual([
      "drive",
      "fathom",
    ]);
    expect(await readdir(join(getDataDir(), "claude-plugin-tastet", "skills"))).toEqual(["libro"]);
  });

  it("adopts a ledger written before profiles were part of the key", async () => {
    createSkillServer(TRACTR).install();
    await skillsSyncCommand({ target: ["codex"] }, createMemoryIO().io);
    // Rewrite the state file the way the previous CLI did: bare target keys.
    const state = await readState();
    const legacy = { version: 1, targets: { codex: state.targets["default:codex"] } };
    await writeFile(getStatePath(), JSON.stringify(legacy));

    const server = createSkillServer(TRACTR);
    server.install();
    await skillsSyncCommand({ target: ["codex"] }, createMemoryIO().io);

    expect(server.downloads()).toBe(0);
    expect(Object.keys((await readState()).targets)).toEqual(["default:codex"]);
  });
});

describe("skills sync — several spaces", () => {
  const AUTOMATIONS: SkillFixture[] = [
    { id: "@tractr/compta", skillMd: skillMd("compta"), spaces: ["spc_2"] },
    // Installed in both spaces: listed once, read from the first space given.
    { id: "@tractr/drive", skillMd: skillMd("drive"), spaces: ["spc_1", "spc_2"] },
  ];
  const SPACES = [
    { id: "spc_1", name: "Default", isDefault: true },
    { id: "spc_2", name: "Automations" },
  ];

  it("syncs the union of the spaces named on the command line, by id or name", async () => {
    createSkillServer([TRACTR[1]!, ...AUTOMATIONS], { spaces: SPACES }).install();
    const { io, stderr } = createMemoryIO();

    await skillsSyncCommand({ target: ["codex"], space: ["spc_1", "Automations"] }, io);

    expect(await listCodex()).toEqual(["compta", "drive", "fathom"]);
    expect(stderr()).toContain("Syncing 2 spaces: spc_1, spc_2");
  });

  it("reads the profile's syncSpaces when no --space is given", async () => {
    createSkillServer([TRACTR[1]!, ...AUTOMATIONS], { spaces: SPACES }).install();
    await updateProfile("default", { syncSpaces: ["spc_2"] });

    await skillsSyncCommand({ target: ["codex"] }, createMemoryIO().io);

    expect(await listCodex()).toEqual(["compta", "drive", "fathom"]);
  });

  it("removes a skill that dropped out of every synced space", async () => {
    createSkillServer([TRACTR[1]!, ...AUTOMATIONS], { spaces: SPACES }).install();
    await skillsSyncCommand({ target: ["codex"], space: ["spc_1", "spc_2"] }, createMemoryIO().io);

    createSkillServer([TRACTR[1]!, AUTOMATIONS[1]!], { spaces: SPACES }).install();
    await skillsSyncCommand({ target: ["codex"], space: ["spc_1", "spc_2"] }, createMemoryIO().io);

    expect(await listCodex()).toEqual(["drive", "fathom"]);
  });

  it("names the available spaces when --space matches nothing", async () => {
    createSkillServer(TRACTR, { spaces: SPACES }).install();
    const { io, stderr } = createMemoryIO();

    await expect(
      skillsSyncCommand({ target: ["codex"], space: ["Sandbox"] }, io),
    ).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toContain('--space "Sandbox" matches no space');
    expect(stderr()).toContain("Automations (spc_2)");
  });

  it("still syncs a profile whose only spaces come from --space", async () => {
    await seedLoggedInProfile("bare", { orgId: "org_1" });
    createSkillServer(TRACTR, { spaces: SPACES }).install();
    await mkdir(codexRoot(), { recursive: true });

    await skillsSyncCommand(
      { profile: "bare", target: ["codex"], space: ["Default"] },
      createMemoryIO().io,
    );

    expect(await listCodex()).toEqual(["drive", "fathom"]);
  });
});
