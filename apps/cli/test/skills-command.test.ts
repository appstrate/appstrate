// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate skills sync`, end to end minus the network.
 *
 * The command is called directly (commander is not in the loop) with a
 * per-test `createMemoryIO()` sink, a throw-away `XDG_CONFIG_HOME` /
 * `XDG_DATA_HOME`, and a throw-away `HOME` so the shared `~/.agents/skills`
 * and `~/.claude/skills` targets land in a tmpdir instead of the developer's
 * home directory.
 *
 * What is asserted here rather than in the unit suites: the properties that
 * only exist once the pieces are wired — the single stdout line under
 * `--print-path`, "unchanged means no download", and the deletion rule that
 * separates a directory this sync created from one the user wrote by hand.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillsSyncCommand } from "../src/commands/skills.ts";
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
import { createSkillServer, skillMd, type SkillFixture } from "./helpers/skills-server.ts";

const configHome = useTempConfigHome("appstrate-cli-skills-cfg-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalDataHome = process.env.XDG_DATA_HOME;

let home: string;
let dataHome: string;

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  home = await mkdtemp(join(tmpdir(), "appstrate-cli-skills-home-"));
  dataHome = await mkdtemp(join(tmpdir(), "appstrate-cli-skills-data-"));
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = dataHome;
  await seedLoggedInProfile("default", { orgId: "org_1", spaceId: "spc_1" });
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
const codexRoot = (): string => join(home, ".agents", "skills");

async function readText(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

/** Files and directories alike — `readdir` alone would say "no" to a file. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

const ONE_SKILL: SkillFixture[] = [
  { id: "@acme/pdf-tools", skillMd: skillMd("PDF Tools", "Work with PDFs.") },
];

describe("skills sync — claude-plugin target", () => {
  it("writes a complete plugin: manifest without a version, README, and one skill dir", async () => {
    createSkillServer(ONE_SKILL).install();
    const { io, stdout } = createMemoryIO();

    await skillsSyncCommand({}, io);

    const manifest = JSON.parse(
      await readText(join(pluginRoot(), ".claude-plugin", "plugin.json")),
    ) as Record<string, unknown>;
    expect(manifest.name).toBe("appstrate");
    expect(manifest).not.toHaveProperty("version");
    expect(await readText(join(pluginRoot(), "README.md"))).toContain("appstrate skills sync");

    const skill = await readText(join(pluginRoot(), "skills", "pdf-tools", "SKILL.md"));
    expect(skill).toContain("name: pdf-tools");
    expect(skill).not.toContain("name: PDF Tools");
    expect(await readdir(join(pluginRoot(), "skills", "pdf-tools"))).toEqual(["SKILL.md"]);
    expect(stdout()).toContain("claude-plugin");
  });

  it("produces byte-identical bytes when rebuilt from scratch", async () => {
    // Two FULL builds, not "build then no-op": the second run of the old test
    // short-circuited and wrote nothing, so it compared a tree against itself.
    const server = createSkillServer([
      ...ONE_SKILL,
      { id: "@acme/notes", skillMd: skillMd("notes"), extraFiles: { "ref/a.md": "a" } },
    ]);
    server.install();
    const { io } = createMemoryIO();

    await skillsSyncCommand({}, io);
    const first = await snapshot(pluginRoot());

    await rm(pluginRoot(), { recursive: true, force: true });
    await rm(getStatePath(), { force: true });
    await skillsSyncCommand({}, io);
    const second = await snapshot(pluginRoot());

    expect(second).toEqual(first);
    expect(server.downloads()).toBe(4); // two skills, two full builds
  });

  it("does not re-download a skill whose integrity is unchanged", async () => {
    const server = createSkillServer(ONE_SKILL);
    server.install();
    const { io } = createMemoryIO();

    await skillsSyncCommand({}, io);
    expect(server.downloads()).toBe(1);

    await skillsSyncCommand({}, io);
    expect(server.downloads()).toBe(1);
  });

  it("re-downloads when the published version moves", async () => {
    createSkillServer(ONE_SKILL).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({}, io);

    const bumped = createSkillServer([
      { ...ONE_SKILL[0]!, version: "2.0.0", skillMd: skillMd("PDF Tools", "Now with tables.") },
    ]);
    bumped.install();
    await skillsSyncCommand({}, io);

    expect(bumped.downloads()).toBe(1);
    expect(await readText(join(pluginRoot(), "skills", "pdf-tools", "SKILL.md"))).toContain(
      "Now with tables.",
    );
  });

  it("renames a colliding skill and says so on stderr", async () => {
    createSkillServer([
      { id: "@acme/pdf-tools", skillMd: skillMd("PDF Tools") },
      { id: "@other/reports", skillMd: skillMd("PDF Tools") },
    ]).install();
    const { io, stderr } = createMemoryIO();

    await skillsSyncCommand({}, io);

    expect(await readdir(join(pluginRoot(), "skills"))).toEqual(["other-reports", "pdf-tools"]);
    expect(stderr()).toContain('Renamed @other/reports to "other-reports"');
  });

  it("skips a skill with no published version without failing the run", async () => {
    createSkillServer([
      ...ONE_SKILL,
      { id: "@acme/unpublished", skillMd: skillMd("unpublished"), unpublished: true },
    ]).install();
    const { io, stderr } = createMemoryIO();

    await skillsSyncCommand({}, io);

    expect(stderr()).toContain("Skipped @acme/unpublished: no published version available.");
    expect(await readdir(join(pluginRoot(), "skills"))).toEqual(["pdf-tools"]);
  });

  it("reports an integrity mismatch and exits non-zero", async () => {
    createSkillServer([{ ...ONE_SKILL[0]!, corruptDownload: true }]).install();
    const { io, stderr } = createMemoryIO();

    await expect(skillsSyncCommand({}, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("Integrity mismatch");
  });
});

describe("skills sync — --print-path", () => {
  it("prints the plugin directory as the only stdout line", async () => {
    createSkillServer([
      ...ONE_SKILL,
      { id: "@acme/unpublished", skillMd: skillMd("unpublished"), unpublished: true },
    ]).install();
    const { io, stdout, stderr } = createMemoryIO();

    await skillsSyncCommand({ printPath: true }, io);

    expect(stdout()).toBe(`${pluginRoot()}\n`);
    expect(stderr()).toContain("Skipped @acme/unpublished");
  });

  it("refuses to run without the claude-plugin target", async () => {
    const { io, stderr } = createMemoryIO();

    await expect(
      skillsSyncCommand({ printPath: true, target: ["codex"] }, io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("--print-path prints the Claude Code plugin directory");
  });
});

describe("skills sync — shared targets", () => {
  it("writes into ~/.agents/skills and leaves a foreign directory alone", async () => {
    const foreign = join(codexRoot(), "my-own-skill");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "SKILL.md"), "mine\n");

    createSkillServer(ONE_SKILL).install();
    const { io } = createMemoryIO();

    await skillsSyncCommand({ target: ["codex"] }, io);

    expect((await readdir(codexRoot())).sort()).toEqual(["my-own-skill", "pdf-tools"]);
    expect(await readText(join(foreign, "SKILL.md"))).toBe("mine\n");
  });

  it("removes a managed directory when the skill leaves the catalogue, and only that one", async () => {
    const foreign = join(codexRoot(), "my-own-skill");
    createSkillServer([...ONE_SKILL, { id: "@acme/notes", skillMd: skillMd("notes") }]).install();
    const { io } = createMemoryIO();

    await skillsSyncCommand({ target: ["codex"] }, io);
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "SKILL.md"), "mine\n");

    createSkillServer(ONE_SKILL).install();
    await skillsSyncCommand({ target: ["codex"] }, io);

    expect((await readdir(codexRoot())).sort()).toEqual(["my-own-skill", "pdf-tools"]);
    expect(await exists(join(codexRoot(), "notes"))).toBe(false);
  });

  it("drops the state entry along with the directory", async () => {
    createSkillServer([...ONE_SKILL, { id: "@acme/notes", skillMd: skillMd("notes") }]).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ target: ["codex"] }, io);

    createSkillServer(ONE_SKILL).install();
    await skillsSyncCommand({ target: ["codex"] }, io);

    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { managed: Record<string, unknown> }>;
    };
    expect(Object.keys(state.targets.codex!.managed)).toEqual(["pdf-tools"]);
  });

  it("re-materializes a skill whose SKILL.md was deleted but whose directory survives", async () => {
    const server = createSkillServer([
      { ...ONE_SKILL[0]!, extraFiles: { "references/guide.md": "# Guide\n" } },
    ]);
    server.install();
    const { io } = createMemoryIO();

    await skillsSyncCommand({ target: ["codex"] }, io);
    // Only SKILL.md goes: the directory, and `references/guide.md` inside it,
    // stay put. The ledger entry still matches the server's integrity, so
    // nothing but an on-disk check can notice the skill is now unloadable.
    await rm(join(codexRoot(), "pdf-tools", "SKILL.md"));

    await skillsSyncCommand({ target: ["codex"] }, io);

    expect(server.downloads()).toBe(2);
    expect(await readText(join(codexRoot(), "pdf-tools", "SKILL.md"))).toContain("name: pdf-tools");
    expect(await readText(join(codexRoot(), "pdf-tools", "references/guide.md"))).toBe("# Guide\n");
  });

  it("re-materializes a skill whose directory a user deleted by hand", async () => {
    const server = createSkillServer(ONE_SKILL);
    server.install();
    const { io } = createMemoryIO();

    await skillsSyncCommand({ target: ["codex"] }, io);
    await rm(join(codexRoot(), "pdf-tools"), { recursive: true, force: true });

    await skillsSyncCommand({ target: ["codex"] }, io);
    expect(server.downloads()).toBe(2);
    expect(await exists(join(codexRoot(), "pdf-tools"))).toBe(true);
  });
});

describe("skills sync — guards and dry run", () => {
  it("exits 1 with a remedy when no space is pinned", async () => {
    await seedLoggedInProfile("default", { orgId: "org_1" });
    const { io, stderr } = createMemoryIO();

    await expect(skillsSyncCommand({}, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toBe("No space pinned. Run: appstrate space switch\n");
  });

  it("exits 1 with a remedy when the profile is not configured", async () => {
    const { io, stderr } = createMemoryIO();

    await expect(skillsSyncCommand({ profile: "nope" }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("Run: appstrate login --profile nope");
  });

  it("writes nothing under --dry-run", async () => {
    const server = createSkillServer(ONE_SKILL);
    server.install();
    const { io, stdout } = createMemoryIO();

    await skillsSyncCommand({ dryRun: true, target: ["claude-plugin", "codex"] }, io);

    expect(await exists(pluginRoot())).toBe(false);
    expect(await exists(codexRoot())).toBe(false);
    expect(server.downloads()).toBe(0);
    expect(stdout()).toContain("+ pdf-tools");
    expect(stdout()).toContain("claude-plugin");
    expect(stdout()).toContain("codex");
  });

  it("treats a corrupt state file as empty and warns instead of crashing", async () => {
    await mkdir(join(getDataDir(), "skills-sync"), { recursive: true });
    await writeFile(getStatePath(), "{ not json");
    createSkillServer(ONE_SKILL).install();
    const { io, stderr } = createMemoryIO();

    await skillsSyncCommand({}, io);

    expect(stderr()).toContain("Sync state could not be used");
    expect(await exists(join(pluginRoot(), "skills", "pdf-tools"))).toBe(true);
  });
});

describe("skills sync — unmanaged destinations", () => {
  it("refuses to overwrite a hand-written skill dir and reports it", async () => {
    const mine = join(codexRoot(), "pdf-tools");
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, "SKILL.md"), "hand written\n");

    createSkillServer(ONE_SKILL).install();
    const { io, stderr } = createMemoryIO();

    await expect(skillsSyncCommand({ target: ["codex"] }, io)).rejects.toBeInstanceOf(ExitError);

    expect(await readText(join(mine, "SKILL.md"))).toBe("hand written\n");
    expect(stderr()).toContain(
      `Skipped @acme/pdf-tools on codex: ${mine} exists and is not managed by appstrate — remove or rename it`,
    );
    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { managed: Record<string, unknown> }>;
    };
    expect(Object.keys(state.targets.codex!.managed)).toEqual([]);
  });

  it("still syncs the plugin target when a shared target is blocked", async () => {
    await mkdir(join(codexRoot(), "pdf-tools"), { recursive: true });
    createSkillServer(ONE_SKILL).install();
    const { io } = createMemoryIO();

    await expect(
      skillsSyncCommand({ target: ["claude-plugin", "codex"] }, io),
    ).rejects.toBeInstanceOf(ExitError);

    expect(await exists(join(pluginRoot(), "skills", "pdf-tools"))).toBe(true);
  });
});

describe("skills sync — exit codes", () => {
  it("exits 0 under --print-path when only individual skills failed", async () => {
    createSkillServer([
      ...ONE_SKILL,
      { id: "@acme/broken", skillMd: skillMd("broken"), corruptDownload: true },
    ]).install();
    const { io, stdout, stderr } = createMemoryIO();

    await skillsSyncCommand({ printPath: true }, io);

    expect(stdout()).toBe(`${pluginRoot()}\n`);
    expect(stderr()).toContain("Integrity mismatch");
    expect(await exists(join(pluginRoot(), "skills", "pdf-tools"))).toBe(true);
  });

  it("exits 1 without --print-path for the same per-skill failure", async () => {
    createSkillServer([
      ...ONE_SKILL,
      { id: "@acme/broken", skillMd: skillMd("broken"), corruptDownload: true },
    ]).install();
    const { io } = createMemoryIO();

    await expect(skillsSyncCommand({}, io)).rejects.toBeInstanceOf(ExitError);
  });

  it("exits 1 and prints nothing on stdout when the catalogue call fails", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const { io, stdout } = createMemoryIO();

    await expect(skillsSyncCommand({ printPath: true }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stdout()).toBe("");
  });
});

describe("skills sync — resilience", () => {
  it("keeps the previous version of a skill whose refresh failed", async () => {
    createSkillServer(ONE_SKILL).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({}, io);

    createSkillServer([{ ...ONE_SKILL[0]!, version: "2.0.0", corruptDownload: true }]).install();
    await expect(skillsSyncCommand({}, io)).rejects.toBeInstanceOf(ExitError);

    // The v1 directory must survive: a full-tree rebuild that dropped it would
    // delete a working skill because the NEW one could not be fetched.
    expect(await exists(join(pluginRoot(), "skills", "pdf-tools"))).toBe(true);
    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { managed: Record<string, { version: string }> }>;
    };
    expect(state.targets["claude-plugin"]!.managed["pdf-tools"]!.version).toBe("1.0.0");
  });

  it("rebuilds when the plugin root exists without its manifest", async () => {
    const server = createSkillServer(ONE_SKILL);
    server.install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({}, io);
    await rm(join(pluginRoot(), ".claude-plugin"), { recursive: true, force: true });

    await skillsSyncCommand({}, io);
    expect(await exists(join(pluginRoot(), ".claude-plugin"))).toBe(true);
  });

  it("leaves no staging directory inside a shared root", async () => {
    createSkillServer(ONE_SKILL).install();
    const { io } = createMemoryIO();

    await skillsSyncCommand({ target: ["codex"] }, io);

    expect(await readdir(codexRoot())).toEqual(["pdf-tools"]);
  });
});

describe("skills sync — --source draft", () => {
  const DRAFT: SkillFixture[] = [
    {
      id: "@acme/pdf-tools",
      skillMd: skillMd("PDF Tools", "Published copy."),
      draft: {
        skillMd: skillMd("PDF Tools", "Draft copy."),
        lockVersion: 3,
        etag: "idx-a",
        inlineFiles: { "reference/small.md": "small" },
        fetchedFiles: { "assets/big.txt": "big" },
      },
    },
  ];

  it("materializes the working copy and reuses the index's inline text", async () => {
    const server = createSkillServer(DRAFT);
    server.install();
    const { io } = createMemoryIO();

    await skillsSyncCommand({ source: "draft" }, io);

    const dir = join(pluginRoot(), "skills", "pdf-tools");
    expect(await readText(join(dir, "SKILL.md"))).toContain("Draft copy.");
    expect(await readText(join(dir, "reference/small.md"))).toBe("small");
    expect(await readText(join(dir, "assets/big.txt"))).toBe("big");
    expect(await readdir(dir)).not.toContain("manifest.json");
    // Only the one entry the index did not inline is fetched — `SKILL.md`,
    // `manifest.json` and `reference/small.md` cost no extra request.
    expect(server.contentReads()).toBe(1);
    expect(server.downloads()).toBe(0);
    // The index is read ONCE: resolution needs its ETag as the change token
    // and hands the same body to the download, so the two halves cannot see
    // different snapshots of a draft edited between them.
    expect(server.indexReads()).toBe(1);
  });

  it("does not re-fetch when neither the ETag nor lock_version moved", async () => {
    const server = createSkillServer(DRAFT);
    server.install();
    const { io } = createMemoryIO();

    await skillsSyncCommand({ source: "draft" }, io);
    const after = server.contentReads();
    await skillsSyncCommand({ source: "draft" }, io);

    expect(server.contentReads()).toBe(after);
  });

  it("re-materializes when the draft ETag moves", async () => {
    createSkillServer(DRAFT).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ source: "draft" }, io);

    const edited = createSkillServer([
      {
        ...DRAFT[0]!,
        draft: {
          ...DRAFT[0]!.draft!,
          skillMd: skillMd("PDF Tools", "Edited draft."),
          lockVersion: 4,
          etag: "idx-b",
        },
      },
    ]);
    edited.install();
    await skillsSyncCommand({ source: "draft" }, io);

    expect(edited.contentReads()).toBe(1);
    expect(await readText(join(pluginRoot(), "skills", "pdf-tools", "SKILL.md"))).toContain(
      "Edited draft.",
    );
  });

  it("re-materializes everything when --source flips", async () => {
    const server = createSkillServer(DRAFT);
    server.install();
    const { io } = createMemoryIO();

    await skillsSyncCommand({ source: "draft" }, io);
    expect(server.downloads()).toBe(0);

    await skillsSyncCommand({ source: "published" }, io);

    expect(server.downloads()).toBe(1);
    expect(await readText(join(pluginRoot(), "skills", "pdf-tools", "SKILL.md"))).toContain(
      "Published copy.",
    );
  });
});

describe("skills sync — a failed resolution is not a deletion", () => {
  const TWO: SkillFixture[] = [...ONE_SKILL, { id: "@acme/notes", skillMd: skillMd("notes") }];

  it("keeps the directory and the ledger entry when versions/latest 500s", async () => {
    createSkillServer(TWO).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ target: ["claude-plugin", "codex"] }, io);

    // Same catalogue, one skill now failing to resolve. Nothing about that
    // says the skill is gone.
    createSkillServer([
      ONE_SKILL[0]!,
      { id: "@acme/notes", skillMd: skillMd("notes"), resolveError: 500 },
    ]).install();
    await expect(
      skillsSyncCommand({ target: ["claude-plugin", "codex"] }, io),
    ).rejects.toBeInstanceOf(ExitError);

    expect((await readdir(join(pluginRoot(), "skills"))).sort()).toEqual(["notes", "pdf-tools"]);
    expect((await readdir(codexRoot())).sort()).toEqual(["notes", "pdf-tools"]);
    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { managed: Record<string, unknown> }>;
    };
    expect(Object.keys(state.targets["claude-plugin"]!.managed).sort()).toEqual([
      "notes",
      "pdf-tools",
    ]);
    expect(Object.keys(state.targets.codex!.managed).sort()).toEqual(["notes", "pdf-tools"]);
  });

  it("exits 0 under --print-path and still prints the path", async () => {
    createSkillServer(TWO).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ printPath: true }, io);

    createSkillServer([
      ONE_SKILL[0]!,
      { id: "@acme/notes", skillMd: skillMd("notes"), resolveError: 500 },
    ]).install();
    const second = createMemoryIO();
    await skillsSyncCommand({ printPath: true }, second.io);

    expect(second.stdout()).toBe(`${pluginRoot()}\n`);
    expect(await exists(join(pluginRoot(), "skills", "notes"))).toBe(true);
  });

  it("still deletes a skill that genuinely left the catalogue", async () => {
    createSkillServer(TWO).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ target: ["codex"] }, io);

    createSkillServer(ONE_SKILL).install();
    await skillsSyncCommand({ target: ["codex"] }, io);

    expect(await readdir(codexRoot())).toEqual(["pdf-tools"]);
  });

  it("stops claiming an unresolved skill whose directory is already gone", async () => {
    createSkillServer(TWO).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ target: ["codex"] }, io);
    await rm(join(codexRoot(), "notes"), { recursive: true, force: true });

    createSkillServer([
      ONE_SKILL[0]!,
      { id: "@acme/notes", skillMd: skillMd("notes"), resolveError: 500 },
    ]).install();
    await expect(skillsSyncCommand({ target: ["codex"] }, io)).rejects.toBeInstanceOf(ExitError);

    // Nothing on disk and nothing fetchable: there is nothing to retain, and
    // a ledger entry pointing at a missing directory would later fail the
    // plugin rebuild that copies carried-over directories.
    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { managed: Record<string, unknown> }>;
    };
    expect(Object.keys(state.targets.codex!.managed)).toEqual(["pdf-tools"]);
  });

  it("does not let a failed resolution hand its slug to another skill", async () => {
    // Both claim `pdf-tools`; `@acme/pdf-tools` sorts first and keeps it.
    createSkillServer([
      { id: "@acme/pdf-tools", skillMd: skillMd("PDF Tools") },
      { id: "@zz/other", skillMd: skillMd("PDF Tools") },
    ]).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({}, io);
    expect((await readdir(join(pluginRoot(), "skills"))).sort()).toEqual(["pdf-tools", "zz-other"]);

    createSkillServer([
      { id: "@acme/pdf-tools", skillMd: skillMd("PDF Tools"), resolveError: 500 },
      { id: "@zz/other", skillMd: skillMd("PDF Tools") },
    ]).install();
    await expect(skillsSyncCommand({}, io)).rejects.toBeInstanceOf(ExitError);

    // `@zz/other` must NOT be promoted to `pdf-tools`: that command belongs to
    // a skill that is still in the catalogue and merely failed to answer.
    expect((await readdir(join(pluginRoot(), "skills"))).sort()).toEqual(["pdf-tools", "zz-other"]);
  });
});

describe("skills sync — ledger ownership", () => {
  it("refuses to overwrite directories recorded under a different HOME", async () => {
    createSkillServer(ONE_SKILL).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ target: ["codex"] }, io);

    // Same profile and same state file, different HOME: cron, launchd,
    // `sudo -E`, a devcontainer. The ledger describes the OTHER tree.
    const otherHome = await mkdtemp(join(tmpdir(), "appstrate-cli-skills-home2-"));
    process.env.HOME = otherHome;
    const mine = join(otherHome, ".agents", "skills", "pdf-tools");
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, "SKILL.md"), "hand written\n");

    const second = createMemoryIO();
    await expect(skillsSyncCommand({ target: ["codex"] }, second.io)).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(await readText(join(mine, "SKILL.md"))).toBe("hand written\n");
    expect(second.stderr()).toContain("is not managed by appstrate");
    await rm(otherHome, { recursive: true, force: true });
  });

  it("carries the ledger of a target this run did not touch", async () => {
    createSkillServer(ONE_SKILL).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ target: ["claude-plugin", "codex"] }, io);

    // The README's first example: no `--target`, so only the plugin is synced.
    // The codex ledger must survive it — otherwise the next marketplace run
    // finds the directory it wrote itself and refuses it as unmanaged.
    await skillsSyncCommand({}, io);
    const after = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { managed: Record<string, unknown> }>;
    };
    expect(Object.keys(after.targets.codex!.managed)).toEqual(["pdf-tools"]);

    const third = createMemoryIO();
    await skillsSyncCommand({ target: ["claude-plugin", "codex"] }, third.io);
    expect(third.stderr()).not.toContain("is not managed by appstrate");
    expect(await exists(join(codexRoot(), "pdf-tools", "SKILL.md"))).toBe(true);
  });

  it("does not record a slug whose write failed", async () => {
    createSkillServer([...ONE_SKILL, { id: "@acme/notes", skillMd: skillMd("notes") }]).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ target: ["codex"] }, io);

    // `notes` leaves the catalogue, and its managed directory has been
    // replaced by a plain file — `removeManagedDir` refuses it and throws.
    await rm(join(codexRoot(), "notes"), { recursive: true, force: true });
    await writeFile(join(codexRoot(), "notes"), "not a directory\n");

    createSkillServer(ONE_SKILL).install();
    const second = createMemoryIO();
    await expect(skillsSyncCommand({ target: ["codex"] }, second.io)).rejects.toBeInstanceOf(
      ExitError,
    );

    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { root: string; managed: Record<string, unknown> }>;
    };
    expect(state.targets.codex!.root).toBe(codexRoot());
    expect(Object.keys(state.targets.codex!.managed)).toEqual(["pdf-tools"]);
  });

  it("keeps --print-path at exit 0 when only the passenger target failed to write", async () => {
    await seedTwoThenBreakCodexNotes();

    const withPath = createMemoryIO();
    await skillsSyncCommand({ target: ["claude-plugin", "codex"], printPath: true }, withPath.io);

    expect(withPath.stdout()).toBe(`${pluginRoot()}\n`);
    expect(withPath.stderr()).toContain("Failed to remove codex/notes");
    expect(await exists(join(pluginRoot(), "skills", "pdf-tools"))).toBe(true);
  });

  it("still exits 1 for the same passenger failure without --print-path", async () => {
    await seedTwoThenBreakCodexNotes();

    const plain = createMemoryIO();
    await expect(
      skillsSyncCommand({ target: ["claude-plugin", "codex"] }, plain.io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(plain.stderr()).toContain("Failed to remove codex/notes");
  });
});

/**
 * Sync two skills to both targets, then put a plain FILE where the managed
 * `notes` directory was and shrink the catalogue to one skill: the next run
 * must try to remove `codex/notes`, and `removeManagedDir` must refuse it.
 */
async function seedTwoThenBreakCodexNotes(): Promise<void> {
  createSkillServer([
    { id: "@acme/pdf-tools", skillMd: skillMd("PDF Tools", "Work with PDFs.") },
    { id: "@acme/notes", skillMd: skillMd("notes") },
  ]).install();
  const { io } = createMemoryIO();
  await skillsSyncCommand({ target: ["claude-plugin", "codex"] }, io);

  await rm(join(codexRoot(), "notes"), { recursive: true, force: true });
  await writeFile(join(codexRoot(), "notes"), "not a directory\n");
  createSkillServer([
    { id: "@acme/pdf-tools", skillMd: skillMd("PDF Tools", "Work with PDFs.") },
  ]).install();
}

describe("skills sync — plugin tree hygiene", () => {
  it("rebuilds when a foreign directory appears under skills/", async () => {
    const server = createSkillServer(ONE_SKILL);
    server.install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({}, io);

    await mkdir(join(pluginRoot(), "skills", "intruder"), { recursive: true });
    await writeFile(join(pluginRoot(), "skills", "intruder", "SKILL.md"), "not ours\n");

    await skillsSyncCommand({}, io);

    expect(await readdir(join(pluginRoot(), "skills"))).toEqual(["pdf-tools"]);
    // Rebuilt from what is already on disk — no re-download needed.
    expect(server.downloads()).toBe(1);
  });
});

describe("skills sync — flag combinations", () => {
  it("refuses --print-path together with --dry-run", async () => {
    const { io, stdout, stderr } = createMemoryIO();

    await expect(skillsSyncCommand({ printPath: true, dryRun: true }, io)).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(stdout()).toBe("");
    expect(stderr()).toBe(
      "--print-path cannot be combined with --dry-run: a dry run writes no plugin.\n",
    );
  });
});

describe("skills sync — one bad skill does not cost the plugin", () => {
  it("drops an artifact whose entries conflict and still writes the tree", async () => {
    createSkillServer([
      ...ONE_SKILL,
      // `a` is a file and `a/b` needs `a` to be a directory: the write of this
      // one skill must fail without aborting the whole plugin build.
      {
        id: "@acme/broken",
        skillMd: skillMd("broken"),
        extraFiles: { a: "file", "a/b": "under a file" },
      },
    ]).install();
    const { io, stdout, stderr } = createMemoryIO();

    await skillsSyncCommand({ printPath: true }, io);

    expect(stdout()).toBe(`${pluginRoot()}\n`);
    expect(stderr()).toContain("Failed to write claude-plugin/broken");
    expect(await readdir(join(pluginRoot(), "skills"))).toEqual(["pdf-tools"]);
    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { managed: Record<string, unknown> }>;
    };
    expect(Object.keys(state.targets["claude-plugin"]!.managed)).toEqual(["pdf-tools"]);
  });

  it("keeps existing ledger entries when a new skill's destination is not ours", async () => {
    createSkillServer([...ONE_SKILL, { id: "@acme/notes", skillMd: skillMd("notes") }]).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ target: ["codex"] }, io);

    // A third skill arrives, and something the ledger does not claim already
    // sits at its destination: it takes the BLOCKED path. The two existing
    // entries must survive — they are on disk and still ours.
    await writeFile(join(codexRoot(), "third"), "in the way\n");
    createSkillServer([
      ...ONE_SKILL,
      { id: "@acme/notes", skillMd: skillMd("notes") },
      { id: "@acme/third", skillMd: skillMd("third") },
    ]).install();
    const second = createMemoryIO();
    await expect(skillsSyncCommand({ target: ["codex"] }, second.io)).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(second.stderr()).toContain("is not managed by appstrate");
    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { managed: Record<string, unknown> }>;
    };
    expect(Object.keys(state.targets.codex!.managed).sort()).toEqual(["notes", "pdf-tools"]);
  });

  it("keeps existing ledger entries when a shared-target write actually fails", async () => {
    createSkillServer([...ONE_SKILL, { id: "@acme/notes", skillMd: skillMd("notes") }]).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ target: ["codex"] }, io);

    // A plain FILE where the staging directory has to be created: the write of
    // the new skill fails inside `writeSharedSkill`, not before it.
    await writeFile(join(codexRoot(), ".appstrate-staging"), "in the way\n");
    createSkillServer([
      ...ONE_SKILL,
      { id: "@acme/notes", skillMd: skillMd("notes") },
      { id: "@acme/third", skillMd: skillMd("third") },
    ]).install();
    const second = createMemoryIO();
    await expect(skillsSyncCommand({ target: ["codex"] }, second.io)).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(second.stderr()).toContain("Failed to write codex/third");
    const state = JSON.parse(await readText(getStatePath())) as {
      targets: Record<string, { managed: Record<string, unknown> }>;
    };
    expect(Object.keys(state.targets.codex!.managed).sort()).toEqual(["notes", "pdf-tools"]);
  });
});

describe("skills sync — the plugin tree is repaired, not just extended", () => {
  it("rebuilds when README.md was deleted", async () => {
    createSkillServer(ONE_SKILL).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({}, io);
    await rm(join(pluginRoot(), "README.md"));

    await skillsSyncCommand({}, io);
    expect(await exists(join(pluginRoot(), "README.md"))).toBe(true);
  });

  it("rebuilds when plugin.json was tampered with", async () => {
    createSkillServer(ONE_SKILL).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({}, io);
    await writeFile(join(pluginRoot(), ".claude-plugin", "plugin.json"), '{"name":"other"}');

    await skillsSyncCommand({}, io);
    const manifest = JSON.parse(
      await readText(join(pluginRoot(), ".claude-plugin", "plugin.json")),
    ) as { name: string };
    expect(manifest.name).toBe("appstrate");
  });

  it("rebuilds when a stray file sits in the plugin root", async () => {
    createSkillServer(ONE_SKILL).install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({}, io);
    await writeFile(join(pluginRoot(), "stray.txt"), "not ours\n");

    await skillsSyncCommand({}, io);
    expect((await readdir(pluginRoot())).sort()).toEqual([".claude-plugin", "README.md", "skills"]);
  });

  it("re-materializes everything when the ledger format version moves", async () => {
    const server = createSkillServer(ONE_SKILL);
    server.install();
    const { io } = createMemoryIO();
    await skillsSyncCommand({ target: ["claude-plugin", "codex"] }, io);
    expect(server.downloads()).toBe(1);

    // A CLI whose materializer changed leaves a ledger this build cannot
    // trust: every entry is stale, but ownership is untouched, so the shared
    // root refreshes its own directory instead of refusing it.
    const raw = JSON.parse(await readText(getStatePath())) as { version: number };
    raw.version = 999;
    await writeFile(getStatePath(), JSON.stringify(raw));

    await skillsSyncCommand({ target: ["claude-plugin", "codex"] }, io);
    expect(server.downloads()).toBe(2);
    expect(await exists(join(codexRoot(), "pdf-tools"))).toBe(true);
  });
});

describe("skills sync — request concurrency", () => {
  it("never holds more than eight package-route requests open", async () => {
    const many = Array.from({ length: 24 }, (_, i) => ({
      id: `@acme/skill-${String(i).padStart(2, "0")}`,
      skillMd: skillMd(`skill-${String(i).padStart(2, "0")}`),
    }));
    const server = createSkillServer(many);
    server.install();
    const { io } = createMemoryIO();

    await skillsSyncCommand({}, io);

    expect((await readdir(join(pluginRoot(), "skills"))).length).toBe(24);
    expect(server.peakInFlight()).toBe(8);
  });
});

/** Recursive path → text snapshot, for the determinism assertion. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else out[rel] = await readText(join(dir, entry.name));
    }
  };
  await walk(root, "");
  return out;
}
