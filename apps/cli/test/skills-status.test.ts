// SPDX-License-Identifier: Apache-2.0

/** `appstrate skills status`, and the push that shows it and refuses a clean folder. */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillsPullCommand } from "../src/commands/skills-pull.ts";
import { getPushLocksPath, skillsPushCommand } from "../src/commands/skills-push.ts";
import { lineDiff, skillsStatusCommand } from "../src/commands/skills-status.ts";
import { readConfig, writeConfig } from "../src/lib/config.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { createSkillServer, skillMd, type SkillFixture } from "./helpers/skills-server.ts";

const configHome = useTempConfigHome("appstrate-cli-status-cfg-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;
const originalDataHome = process.env.XDG_DATA_HOME;
let work: string;
let dataHome: string;
let dir: string;

const ORGS = [{ id: "org_1", slug: "acme" }];
const SKILL: SkillFixture = {
  id: "@acme/pdf-tools",
  skillMd: skillMd("pdf-tools", "Work with PDFs."),
  version: "1.5.0",
  draft: {
    lockVersion: 4,
    inlineFiles: { "scripts/run.sh": "#!/bin/sh\necho run\n", "references/guide.md": "# Guide\n" },
  },
};

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  work = await mkdtemp(join(tmpdir(), "appstrate-cli-status-"));
  dataHome = await mkdtemp(join(tmpdir(), "appstrate-cli-status-data-"));
  process.env.XDG_DATA_HOME = dataHome;
  await seedLoggedInProfile("default", { orgId: "org_1", spaceId: "spc_1" });
  await writeConfig({ ...(await readConfig()), workDir: join(work, "Appstrate Packages") });
  createSkillServer([SKILL], { orgs: ORGS }).install();
  await skillsPullCommand({ skill: "pdf-tools" }, createMemoryIO().io);
  dir = join(work, "Appstrate Packages", "acme", "packages", "skills", "pdf-tools");
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

describe("skills status", () => {
  it("is clean right after a pull", async () => {
    const { io, stdout } = createMemoryIO();
    await skillsStatusCommand({ dir: "pdf-tools" }, io);
    expect(stdout()).toContain("clean: the folder matches the draft");
  });

  it("lists modified, added and removed files, with a diff on request", async () => {
    await writeFile(join(dir, "scripts", "run.sh"), "#!/bin/sh\necho changed\n");
    await writeFile(join(dir, "scripts", "new.sh"), "echo new\n");
    await rm(join(dir, "references", "guide.md"));
    const { io, stdout } = createMemoryIO();

    await skillsStatusCommand({ dir: "pdf-tools", diff: true }, io);

    const out = stdout();
    expect(out).toContain("  M scripts/run.sh");
    expect(out).toContain("  A scripts/new.sh");
    expect(out).toContain("  D references/guide.md");
    expect(out).toContain("- echo run");
    expect(out).toContain("+ echo changed");
  });

  it("warns when the draft moved elsewhere since this machine last saw it", async () => {
    const locks = JSON.parse(await readFile(getPushLocksPath("default"), "utf-8")) as Record<
      string,
      number
    >;
    expect(locks["@acme/pdf-tools"]).toBe(4);
    createSkillServer([{ ...SKILL, draft: { ...SKILL.draft, lockVersion: 6 } }], {
      orgs: ORGS,
    }).install();
    const { io, stdout } = createMemoryIO();

    await skillsStatusCommand({ dir: "pdf-tools" }, io);

    expect(stdout()).toContain("edited elsewhere since this machine last saw it (lock 4 → 6)");
  });

  it("makes push show the changes and refuse a clean folder", async () => {
    const clean = createMemoryIO();
    await skillsPushCommand({ dir: "pdf-tools" }, clean.io);
    expect(clean.stdout()).toContain("Nothing to push");

    await writeFile(join(dir, "scripts", "new.sh"), "echo new\n");
    const server = createSkillServer([SKILL], { orgs: ORGS });
    server.install();
    const { io, stderr, stdout } = createMemoryIO();
    await skillsPushCommand({ dir: "pdf-tools" }, io);

    expect(stderr()).toContain("  A scripts/new.sh");
    expect(stdout()).toContain("Pushed @acme/pdf-tools");
    expect(server.imports()).toHaveLength(1);
  });
});

describe("lineDiff", () => {
  it("marks removed, added and kept lines", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c"])).toEqual(["  a", "- b", "+ x", "  c"]);
  });
});
