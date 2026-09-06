// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate skills push` and `appstrate skills publish` — a local folder to
 * the draft, the draft to a version. The network is the same stub the sync
 * suites use; what is asserted is what reaches the server.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bumpPatch,
  frontmatterVersion,
  getPushLocksPath,
  skillsPublishCommand,
  skillsPushCommand,
} from "../src/commands/skills-push.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { ExitError } from "./helpers/process-exit.ts";
import { createSkillServer, skillMd, type SkillServerOptions } from "./helpers/skills-server.ts";

const configHome = useTempConfigHome("appstrate-cli-push-cfg-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;
const originalDataHome = process.env.XDG_DATA_HOME;
let work: string;
let dataHome: string;

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  work = await mkdtemp(join(tmpdir(), "appstrate-cli-push-"));
  dataHome = await mkdtemp(join(tmpdir(), "appstrate-cli-push-data-"));
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

const ORGS: SkillServerOptions["orgs"] = [{ id: "org_1", slug: "acme" }];

/** A skill folder with `SKILL.md` and, optionally, annex files. */
async function skillFolder(
  name: string,
  files: Record<string, string> = {},
  body = skillMd(name, "Work with PDFs."),
): Promise<string> {
  const dir = join(work, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

describe("skills push", () => {
  it("sends the folder as a draft, annex files included, under a synthesized manifest", async () => {
    const server = createSkillServer(
      [{ id: "@acme/pdf-tools", skillMd: skillMd("pdf-tools"), version: "1.2.0" }],
      { orgs: ORGS },
    );
    server.install();
    const dir = await skillFolder("pdf-tools", {
      "scripts/run.sh": "#!/bin/sh\n",
      "references/guide.md": "# Guide\n",
      ".DS_Store": "junk",
    });
    const { io, stdout, stderr } = createMemoryIO();

    await skillsPushCommand({ dir }, io);

    const [sent] = server.imports();
    expect(sent?.query).toEqual({ draft: "true" });
    expect(sent?.filename).toBe("pdf-tools.afps");
    expect(Object.keys(sent!.files).sort()).toEqual([
      "SKILL.md",
      "manifest.json",
      "references/guide.md",
      "scripts/run.sh",
    ]);
    // Org slug from /api/orgs, patch bump over the latest published version.
    expect(sent?.manifest).toMatchObject({
      name: "@acme/pdf-tools",
      version: "1.2.1",
      type: "skill",
      display_name: "pdf-tools",
      description: "Work with PDFs.",
    });
    expect(stdout()).toContain(
      "Pushed @acme/pdf-tools to its draft (4 files, would publish as 1.2.1)",
    );
    expect(stderr()).toContain("appstrate skills sync --source draft");
  });

  it("starts a never-published skill at 1.0.0 and honours a frontmatter version", async () => {
    const server = createSkillServer([], { orgs: ORGS });
    server.install();
    const fresh = await skillFolder("notes");
    const pinned = await skillFolder(
      "pinned",
      {},
      "---\nname: pinned\ndescription: Pinned.\nversion: 3.4.5\n---\n\nBody.\n",
    );

    await skillsPushCommand({ dir: fresh }, createMemoryIO().io);
    await skillsPushCommand({ dir: pinned }, createMemoryIO().io);

    expect(server.imports()[0]?.manifest).toMatchObject({ name: "@acme/notes", version: "1.0.0" });
    expect(server.imports()[1]?.manifest).toMatchObject({ name: "@acme/pinned", version: "3.4.5" });
  });

  it("passes an authored manifest.json through and lets --id rename it", async () => {
    const server = createSkillServer([], { orgs: ORGS });
    server.install();
    const dir = await skillFolder("pdf-tools", {
      "manifest.json": JSON.stringify({
        name: "@other/pdf-tools",
        version: "2.0.0",
        type: "skill",
        schema_version: "0.1",
        keywords: ["pdf"],
      }),
    });

    await skillsPushCommand({ dir }, createMemoryIO().io);
    await skillsPushCommand({ dir, id: "@tractr/pdf-tools" }, createMemoryIO().io);

    expect(server.imports()[0]?.manifest).toMatchObject({
      name: "@other/pdf-tools",
      version: "2.0.0",
      keywords: ["pdf"],
    });
    expect(server.imports()[1]?.manifest).toMatchObject({ name: "@tractr/pdf-tools" });
  });

  it("remembers the lock it received and re-pushes its own work without --force", async () => {
    // A dirty draft refuses every push that cannot prove it wrote the draft.
    const server = createSkillServer([], { orgs: ORGS, draftDirty: true });
    server.install();
    const dir = await skillFolder("pdf-tools");

    await skillsPushCommand({ dir, force: true }, createMemoryIO().io);
    const locks = JSON.parse(await readFile(getPushLocksPath("default"), "utf-8")) as Record<
      string,
      number
    >;
    expect(locks["@acme/pdf-tools"]).toBe(2);

    await writeFile(join(dir, "scripts.sh"), "echo more\n");
    await skillsPushCommand({ dir }, createMemoryIO().io);

    expect(server.imports()[1]?.query).toEqual({ draft: "true", lock_version: "2" });
    expect(Object.keys(server.imports()[1]!.files)).toContain("scripts.sh");
  });

  it("stops on a dirty draft with the --force remedy, and --force sends force=true", async () => {
    const server = createSkillServer([], { orgs: ORGS, draftDirty: true });
    server.install();
    const dir = await skillFolder("pdf-tools");
    const { io, stderr } = createMemoryIO();

    await expect(skillsPushCommand({ dir }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("HTTP 409");
    expect(stderr()).toContain("Re-run with --force");

    await skillsPushCommand({ dir, force: true }, createMemoryIO().io);
    expect(server.imports()[1]?.query).toEqual({ draft: "true", force: "true" });
  });

  it("warns and exits 1 when the instance published instead of writing the draft", async () => {
    const server = createSkillServer([], { orgs: ORGS, ignoresDraft: true });
    server.install();
    const dir = await skillFolder("pdf-tools");
    const { io, stderr } = createMemoryIO();

    await expect(skillsPushCommand({ dir }, io)).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toContain("PUBLISHED @acme/pdf-tools@1.0.0 instead");
  });

  it("waits out a 429 and retries, so a bulk push needs no pacing loop", async () => {
    const server = createSkillServer([], { orgs: ORGS, rateLimitFirst: 2 });
    server.install();
    const dir = await skillFolder("pdf-tools");
    const { io, stdout, stderr } = createMemoryIO();

    await skillsPushCommand({ dir }, io);

    expect(server.imports()).toHaveLength(1);
    expect(stderr()).toContain("waiting 1s before retrying (1/3)");
    expect(stderr()).toContain("(2/3)");
    expect(stdout()).toContain("Pushed @acme/pdf-tools");
  });

  it("uploads nothing under --dry-run and shows what would change", async () => {
    const server = createSkillServer([], { orgs: ORGS });
    server.install();
    const dir = await skillFolder("pdf-tools", { "scripts/run.sh": "#!/bin/sh\n" });
    const { io, stdout, stderr } = createMemoryIO();

    await skillsPushCommand({ dir, dryRun: true }, io);

    expect(server.imports()).toHaveLength(0);
    expect(stdout()).toContain("@acme/pdf-tools draft ←");
    expect(stdout()).toContain("dry run");
    expect(stderr()).toContain("not on Appstrate yet");
    expect(stderr()).toContain("  A scripts/run.sh");
  });

  it("refuses a folder without SKILL.md, and a profile without an org", async () => {
    createSkillServer([], { orgs: ORGS }).install();
    const empty = join(work, "empty");
    await mkdir(empty);
    const { io, stderr } = createMemoryIO();

    await expect(skillsPushCommand({ dir: empty }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("no SKILL.md at the top level");

    await seedLoggedInProfile("bare", {});
    const second = createMemoryIO();
    await expect(
      skillsPushCommand({ dir: await skillFolder("x"), profile: "bare" }, second.io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(second.stderr()).toContain("No organization pinned");
  });
});

describe("skills publish", () => {
  it("cuts a version from the draft, resolving a bare name under the org slug", async () => {
    const server = createSkillServer(
      [{ id: "@acme/pdf-tools", skillMd: skillMd("pdf-tools"), version: "1.2.1" }],
      { orgs: ORGS },
    );
    server.install();
    const { io, stdout } = createMemoryIO();

    await skillsPublishCommand({ skill: "pdf-tools" }, io);

    expect(server.publishes()).toEqual([{ packageId: "@acme/pdf-tools", body: {} }]);
    expect(stdout()).toBe("Published @acme/pdf-tools@1.2.1.\n");
  });

  it("passes --version through and explains a 409", async () => {
    const server = createSkillServer([], { orgs: ORGS, versionExists: true });
    server.install();
    const { io, stderr } = createMemoryIO();

    await expect(
      skillsPublishCommand({ skill: "@acme/pdf-tools", version: "1.3.0" }, io),
    ).rejects.toBeInstanceOf(ExitError);

    expect(server.publishes()).toEqual([
      { packageId: "@acme/pdf-tools", body: { version: "1.3.0" } },
    ]);
    expect(stderr()).toContain("pass --version <next>");
  });
});

describe("helpers", () => {
  it("bumps the patch and reads a frontmatter version", () => {
    expect(bumpPatch("1.2.9")).toBe("1.2.10");
    expect(bumpPatch("2.0.0-rc.1")).toBe("2.0.1");
    expect(bumpPatch("nope")).toBe("1.0.0");
    expect(frontmatterVersion('---\nname: x\nversion: "0.4.2"\n---\n')).toBe("0.4.2");
    expect(frontmatterVersion("---\nname: x\n---\nversion: 9.9.9\n")).toBeUndefined();
  });
});
