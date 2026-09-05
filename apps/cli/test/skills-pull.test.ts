// SPDX-License-Identifier: Apache-2.0

/** `appstrate skills pull` — a skill into a working folder, then `push` from it without --force. */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillsPullCommand } from "../src/commands/skills-pull.ts";
import { getPushLocksPath, skillsPushCommand } from "../src/commands/skills-push.ts";
import { readConfig, writeConfig } from "../src/lib/config.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { ExitError } from "./helpers/process-exit.ts";
import { createSkillServer, skillMd, type SkillFixture } from "./helpers/skills-server.ts";

const configHome = useTempConfigHome("appstrate-cli-pull-cfg-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;
const originalDataHome = process.env.XDG_DATA_HOME;
let work: string;
let dataHome: string;

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  work = await mkdtemp(join(tmpdir(), "appstrate-cli-pull-"));
  dataHome = await mkdtemp(join(tmpdir(), "appstrate-cli-pull-data-"));
  process.env.XDG_DATA_HOME = dataHome;
  await seedLoggedInProfile("default", { orgId: "org_1", spaceId: "spc_1" });
});

afterEach(async () => {
  keyring.restore();
  globalThis.fetch = originalFetch;
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  await configHome.teardown();
  await rm(work, { recursive: true, force: true });
  await rm(dataHome, { recursive: true, force: true });
});

const ORGS = [{ id: "org_1", slug: "acme" }];

/** Published 1.5.0 with one script; the draft carries an extra reference and lock 4. */
const SKILL: SkillFixture = {
  id: "@acme/pdf-tools",
  skillMd: skillMd("pdf-tools", "Work with PDFs."),
  version: "1.5.0",
  extraFiles: { "scripts/run.sh": "#!/bin/sh\n" },
  draft: {
    lockVersion: 4,
    inlineFiles: { "scripts/run.sh": "#!/bin/sh\n", "references/guide.md": "# Guide\n" },
  },
};

async function listTree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listTree(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe("skills pull — the work dir", () => {
  it("lands in <workDir>/<org slug>/packages/skills/<name> when no folder is given", async () => {
    createSkillServer([SKILL], { orgs: ORGS }).install();
    const workDir = join(work, "Appstrate");
    await writeConfig({ ...(await readConfig()), workDir });
    const { io, stdout } = createMemoryIO();

    await skillsPullCommand({ skill: "pdf-tools" }, io);

    const expected = join(workDir, "acme", "packages", "skills", "pdf-tools");
    expect(await listTree(expected)).toContain("SKILL.md");
    expect(stdout()).toContain(`into ${expected}`);
  });

  it("refuses a work dir that is an instance directory", async () => {
    createSkillServer([SKILL], { orgs: ORGS }).install();
    const workDir = join(work, "Appstrate");
    await mkdir(join(workDir, ".appstrate"), { recursive: true });
    await writeFile(join(workDir, ".appstrate", "project.json"), "{}");
    await writeConfig({ ...(await readConfig()), workDir });
    const { io, stderr } = createMemoryIO();

    await expect(skillsPullCommand({ skill: "pdf-tools" }, io)).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toContain("is an Appstrate instance directory");
    expect(stderr()).toContain("uninstall --purge");
  });

  it("lets push find that working copy by its bare name", async () => {
    const server = createSkillServer([SKILL], { orgs: ORGS });
    server.install();
    const workDir = join(work, "Appstrate");
    await writeConfig({ ...(await readConfig()), workDir });
    await skillsPullCommand({ skill: "pdf-tools" }, createMemoryIO().io);

    await skillsPushCommand({ dir: "pdf-tools" }, createMemoryIO().io);
    expect(server.imports()[0]?.manifest).toMatchObject({ name: "@acme/pdf-tools" });

    const missing = createMemoryIO();
    await expect(skillsPushCommand({ dir: "nowhere" }, missing.io)).rejects.toBeInstanceOf(
      ExitError,
    );
    expect(missing.stderr()).toContain("No working copy for nowhere at");
    expect(missing.stderr()).toContain("appstrate skills pull nowhere");
  });
});

describe("skills pull", () => {
  it("writes the draft into the folder, manifest included, and records the draft lock", async () => {
    createSkillServer([SKILL], { orgs: ORGS }).install();
    const dir = join(work, "pdf-tools");
    const { io, stdout } = createMemoryIO();

    await skillsPullCommand({ skill: "pdf-tools", dir }, io);

    expect(await listTree(dir)).toEqual([
      "SKILL.md",
      "manifest.json",
      "references/guide.md",
      "scripts/run.sh",
    ]);
    expect(stdout()).toContain("Pulled @acme/pdf-tools (draft, 4 files)");
    const locks = JSON.parse(await readFile(getPushLocksPath("default"), "utf-8")) as Record<
      string,
      number
    >;
    expect(locks["@acme/pdf-tools"]).toBe(4);
  });

  it("pulls a published version with --version and still records the draft lock", async () => {
    createSkillServer([SKILL], { orgs: ORGS }).install();
    const dir = join(work, "v");
    const { io, stdout } = createMemoryIO();

    await skillsPullCommand({ skill: "@acme/pdf-tools", dir, version: "1.5.0" }, io);

    expect(await listTree(dir)).toEqual(["SKILL.md", "manifest.json", "scripts/run.sh"]);
    expect(stdout()).toContain("version 1.5.0");
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf-8")) as {
      version: string;
    };
    expect(manifest.version).toBe("1.5.0");
  });

  it("refuses a folder with files unless --force, and names a missing version", async () => {
    createSkillServer([SKILL], { orgs: ORGS }).install();
    const dir = join(work, "busy");
    await mkdir(dir);
    await writeFile(join(dir, "notes.md"), "mine\n");
    const first = createMemoryIO();

    await expect(skillsPullCommand({ skill: "pdf-tools", dir }, first.io)).rejects.toBeInstanceOf(
      ExitError,
    );
    expect(first.stderr()).toContain("is not empty");

    await skillsPullCommand({ skill: "pdf-tools", dir, force: true }, createMemoryIO().io);
    expect(await readFile(join(dir, "notes.md"), "utf-8")).toBe("mine\n");
    expect(await listTree(dir)).toContain("SKILL.md");

    const missing = createMemoryIO();
    await expect(
      skillsPullCommand({ skill: "pdf-tools", dir: join(work, "x"), version: "9.9.9" }, missing.io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(missing.stderr()).toContain("has no version 9.9.9");
  });

  it("pull, edit, push: the push carries the pulled lock and bumps the published version", async () => {
    const server = createSkillServer([SKILL], { orgs: ORGS, draftDirty: true });
    server.install();
    const dir = join(work, "pdf-tools");
    // The stub's import lock starts at 1; the detail says 4. Align them by
    // pulling from a fixture whose draft lock is what the import side expects.
    await skillsPullCommand({ skill: "pdf-tools", dir, version: "latest" }, createMemoryIO().io);
    const locks = JSON.parse(await readFile(getPushLocksPath("default"), "utf-8")) as Record<
      string,
      number
    >;
    locks["@acme/pdf-tools"] = 1;
    await writeFile(getPushLocksPath("default"), JSON.stringify(locks));

    await writeFile(join(dir, "scripts", "more.sh"), "echo more\n");
    await skillsPushCommand({ dir }, createMemoryIO().io);

    const [sent] = server.imports();
    expect(sent?.query).toEqual({ draft: "true", lock_version: "1" });
    // The pulled manifest said 1.5.0, which is published: push moves to 1.5.1.
    expect(sent?.manifest).toMatchObject({ name: "@acme/pdf-tools", version: "1.5.1" });
    expect(Object.keys(sent!.files)).toContain("scripts/more.sh");
  });
});
