// SPDX-License-Identifier: Apache-2.0

/**
 * `lib/skills-sync/plan.ts` — catalogue reading, version pinning, slug
 * assignment (skills and agent commands) and the verified download.
 *
 * `globalThis.fetch` is stubbed with the shared skill server
 * (`helpers/skills-server.ts`) rather than injected: the CLI's whole auth
 * pipeline (`lib/api.ts`) sits between these functions and the network, and
 * routing around it would test a shorter path than production takes.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  assignSlugs,
  fetchSkillFiles,
  listSyncableAgents,
  listSyncableSkills,
  resolveAgent,
  resolveSkill,
  type ResolvedSkill,
} from "../src/lib/skills-sync/plan.ts";
import { treeIntegrity, type AgentLaunchView } from "../src/lib/skills-sync/materialize.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { createSkillServer, skillMd, type AgentFixture } from "./helpers/skills-server.ts";
import { formatError } from "../src/lib/ui.ts";

const configHome = useTempConfigHome("appstrate-cli-skills-plan-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  await seedLoggedInProfile("default", { orgId: "org_1", spaceId: "spc_1" });
});

afterEach(async () => {
  keyring.restore();
  globalThis.fetch = originalFetch;
  await configHome.teardown();
});

function resolved(overrides: Partial<ResolvedSkill> & { packageId: string }): ResolvedSkill {
  return {
    version: "1.0.0",
    integrity: "sha256-x",
    frontmatterName: "",
    ...overrides,
  };
}

describe("listSyncableSkills", () => {
  it("unwraps the list envelope, drops system packages and sorts by id", async () => {
    createSkillServer([
      { id: "@acme/zebra", skillMd: skillMd("zebra") },
      { id: "@appstrate/builtin", skillMd: skillMd("builtin"), source: "system" },
      { id: "@acme/alpha", skillMd: skillMd("alpha") },
    ]).install();

    expect(await listSyncableSkills("default")).toEqual(["@acme/alpha", "@acme/zebra"]);
  });

  // The sync reads what the space OFFERS, which is the ACTIVE set: a skill
  // somebody switched off in the space is not written into the local Claude
  // Code checkout, or the switch would mean nothing outside the dashboard.
  // The stub narrows unconditionally, like the route: a sync that read a wider
  // listing than the index turns this red.
  it("reads the ACTIVE set — a skill switched off in the space is not syncable", async () => {
    createSkillServer([
      { id: "@acme/on", skillMd: skillMd("on") },
      { id: "@acme/off", skillMd: skillMd("off"), inactive: true },
    ]).install();

    expect(await listSyncableSkills("default")).toEqual(["@acme/on"]);
  });
});

describe("resolveSkill", () => {
  it("pins the latest published version and reads the frontmatter name", async () => {
    createSkillServer([
      { id: "@acme/pdf", skillMd: skillMd("PDF Tools", "Work with PDFs."), version: "2.3.1" },
    ]).install();

    const skill = await resolveSkill("default", "@acme/pdf", "published");
    expect(skill?.version).toBe("2.3.1");
    expect(skill?.frontmatterName).toBe("PDF Tools");
    expect(skill?.integrity).toMatch(/^sha256-/);
  });

  it("returns null — not an error — when the skill was never published", async () => {
    createSkillServer([
      { id: "@acme/draft-only", skillMd: skillMd("draft-only"), unpublished: true },
    ]).install();

    expect(await resolveSkill("default", "@acme/draft-only", "published")).toBeNull();
  });
});

describe("resolveSkill — the draft is NAMED, never left to the route's default", () => {
  // Without `?version=draft` the detail and file routes alike serve the
  // definition the detail page renders, which for anyone who cannot write the
  // package is the PUBLISHED version. A sync that omitted the selector on
  // either request would still succeed — and would write published bytes under
  // a ledger entry that calls them a draft. The stub answers an unnamed
  // selector with the published snapshot for exactly that reason, so these
  // assertions fail on content, not on an absent request.
  it("reads the working copy and tokenizes it with the draft index ETag", async () => {
    createSkillServer([
      {
        id: "@acme/pdf",
        skillMd: skillMd("PDF Tools", "Published."),
        extraFiles: { "reference/notes.md": "published notes" },
        draft: {
          skillMd: skillMd("pdf-tools-draft", "Working copy."),
          etag: "idx-9",
          files: { "reference/notes.md": "draft notes" },
        },
      },
    ]).install();

    const skill = (await resolveSkill("default", "@acme/pdf", "draft"))!;
    expect(skill.version).toBe("draft");
    expect(skill.integrity).toBe('draft:"1":"idx-9"');
    // The two fixtures carry DIFFERENT frontmatter names, so this pins the
    // selector on the detail request the same way the bytes below pin it on
    // the file routes: unnamed, the stub answers with the published metadata.
    expect(skill.frontmatterName).toBe("pdf-tools-draft");

    const files = await fetchSkillFiles("default", skill, "draft");
    const decoder = new TextDecoder();
    expect(decoder.decode(files["SKILL.md"]!)).toContain("Working copy.");
    // Only the draft archive carries this text: the published one says otherwise.
    expect(decoder.decode(files["reference/notes.md"]!)).toBe("draft notes");
  });

  it("says whose copy it is when the caller may not write the skill", async () => {
    createSkillServer([
      {
        id: "@acme/pdf",
        skillMd: skillMd("PDF Tools"),
        draft: { skillMd: skillMd("PDF Tools", "Working copy."), notWritable: true },
      },
    ]).install();

    const err = await resolveSkill("default", "@acme/pdf", "draft").then(
      () => null,
      (e: unknown) => e,
    );
    const rendered = formatError(err);
    expect(rendered).toContain("@acme/pdf");
    expect(rendered).toContain("author's working copy");
    expect(rendered).toContain("skills:write");
    expect(rendered).toContain("--source published");
    // The status code alone would send the reader hunting for a permission on
    // the sync command itself.
    expect(rendered).not.toContain("HTTP 403");
  });

  it("explains the same refusal when it lands on the draft archive", async () => {
    // Resolution and download are separate requests: a grant revoked between
    // them refuses the second one, and that refusal must read the same way.
    createSkillServer([
      {
        id: "@acme/pdf",
        skillMd: skillMd("PDF Tools"),
        draft: { skillMd: skillMd("PDF Tools"), notWritable: true },
      },
    ]).install();

    const skill = resolved({
      packageId: "@acme/pdf",
      version: "draft",
      integrity: 'draft:1:"idx-1"',
    });
    const err = await fetchSkillFiles("default", skill, "draft").then(
      () => null,
      (e: unknown) => e,
    );
    expect(formatError(err)).toContain("author's working copy");
    expect(formatError(err)).toContain("skills:write");
    expect(formatError(err)).toContain("--source published");
  });
});

describe("assignSlugs", () => {
  it("gives the short slug to the first claimant and renames the rest", () => {
    const { planned } = assignSlugs([
      resolved({ packageId: "@acme/pdf-tools", frontmatterName: "pdf-tools" }),
      resolved({ packageId: "@other/reports", frontmatterName: "pdf-tools" }),
    ]);

    expect(planned[0]?.slug).toBe("pdf-tools");
    expect(planned[0]?.renamedFrom).toBeUndefined();
    expect(planned[1]?.slug).toBe("other-reports");
    expect(planned[1]?.renamedFrom).toBe("pdf-tools");
  });

  it("is decided by input order, not by which skill was resolved first", () => {
    // Same two skills as above, swapped: the one that comes first keeps the
    // short slug, so the caller's sort by package id is what makes the
    // assignment reproducible.
    const a = resolved({ packageId: "@acme/pdf-tools", frontmatterName: "pdf-tools" });
    const b = resolved({ packageId: "@other/reports", frontmatterName: "pdf-tools" });

    expect(assignSlugs([b, a]).planned.map((s) => s.slug)).toEqual(["pdf-tools", "acme-pdf-tools"]);
  });

  it("never hands two skills the same directory when the fallback itself collides", () => {
    // `@a/b` reduces to `acme-foo` through its FRONTMATTER, and both
    // `@acme/bar` and `@acme/foo` reduce to `acme-foo` through the
    // `<scope>-<name>` fallback. Three claimants, three directories.
    const { planned } = assignSlugs([
      resolved({ packageId: "@a/b", frontmatterName: "acme-foo" }),
      resolved({ packageId: "@acme/bar", frontmatterName: "foo" }),
      resolved({ packageId: "@acme/foo", frontmatterName: "foo" }),
    ]);

    const slugs = planned.map((s) => s.slug);
    expect(slugs).toEqual(["acme-foo", "foo", "acme-foo-2"]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("falls back to the package name segment when the frontmatter name is absent", () => {
    const { planned } = assignSlugs([resolved({ packageId: "@acme/weekly-report" })]);
    expect(planned[0]?.slug).toBe("weekly-report");
  });
});

function view(packageId: string): AgentLaunchView {
  return {
    packageId,
    // Platform-shaped: the command writes it, and refuses any other shape.
    spaceId: "spc_00000000-0000-4000-8000-000000000001",
    version: "1.0.0",
    title: packageId,
    description: "Does a thing.",
    input: { schema: { type: "object", properties: {} }, values: {}, locked_fields: [] },
  };
}

describe("assignSlugs — agent commands (D23)", () => {
  it("prefixes an agent with run- and renders its tree, hashed as rendered", () => {
    const { planned, failed } = assignSlugs([], [view("@acme/report")]);

    expect(failed).toEqual([]);
    const agent = planned[0]!;
    expect(agent.slug).toBe("run-report");
    expect(agent.kind).toBe("agent");
    if (agent.kind !== "agent") throw new Error("expected an agent entry");
    expect(Object.keys(agent.files).sort()).toEqual(["SKILL.md", "input.json"]);
    expect(agent.integrity).toBe(treeIntegrity(agent.files));
  });

  it("assigns every skill before any agent, so an agent never renames a skill", () => {
    // The agent sorts first by package id, and still loses `run-foo` to the skill.
    const { planned } = assignSlugs(
      [
        resolved({ packageId: "@zed/foo", frontmatterName: "foo" }),
        resolved({ packageId: "@zed/run-foo", frontmatterName: "run-foo" }),
      ],
      [view("@acme/foo")],
    );

    expect(planned.map((entry) => [entry.packageId, entry.slug, entry.renamedFrom])).toEqual([
      ["@zed/foo", "foo", undefined],
      ["@zed/run-foo", "run-foo", undefined],
      ["@acme/foo", "run-acme-foo", "run-foo"],
    ]);
  });

  it("keeps the run- prefix through the counter when the fallback collides too", () => {
    const { planned } = assignSlugs(
      [resolved({ packageId: "@zed/run-foo", frontmatterName: "run-foo" })],
      [view("@acme/foo"), view("@other/acme-foo")],
      new Map([["run-acme-foo", "@gone/unresolved"]]),
    );

    expect(planned.map((entry) => entry.slug)).toEqual([
      "run-foo",
      "run-acme-foo-2",
      "run-other-acme-foo",
    ]);
  });

  it("reports an agent whose command cannot be rendered instead of planning it", () => {
    const { planned, failed } = assignSlugs([], [{ ...view("@acme/foo"), version: "not-semver" }]);

    expect(planned).toEqual([]);
    expect(failed.map((f) => f.packageId)).toEqual(["@acme/foo"]);
  });

  it("lets an agent that fails to render leave its name to the next claimant", () => {
    const { planned } = assignSlugs(
      [],
      [{ ...view("@acme/foo"), version: "not-semver" }, view("@zed/foo")],
    );

    expect(planned.map((entry) => [entry.packageId, entry.slug])).toEqual([
      ["@zed/foo", "run-foo"],
    ]);
  });

  it("honours a slug the ledger reserves for an unresolved package", () => {
    const { planned } = assignSlugs(
      [],
      [view("@acme/foo")],
      new Map([["run-foo", "@gone/unresolved"]]),
    );

    expect(planned[0]?.slug).toBe("run-acme-foo");
    expect(planned[0]?.renamedFrom).toBe("run-foo");
  });
});

describe("assignSlugs — an installed name stays with its package", () => {
  const slugsOf = (planned: { packageId: string; slug: string }[]) =>
    Object.fromEntries(planned.map((entry) => [entry.packageId, entry.slug]));

  it("keeps an agent on its name when a newcomer sorts first", () => {
    const { planned } = assignSlugs(
      [],
      [view("@alpha/report"), view("@zeta/report")],
      new Map([["run-report", "@zeta/report"]]),
    );

    expect(slugsOf(planned)).toEqual({
      "@alpha/report": "run-alpha-report",
      "@zeta/report": "run-report",
    });
  });

  it("keeps a skill on its name when a newcomer sorts first", () => {
    const { planned } = assignSlugs(
      [
        resolved({ packageId: "@alpha/report", frontmatterName: "report" }),
        resolved({ packageId: "@zeta/report", frontmatterName: "report" }),
      ],
      [],
      new Map([["report", "@zeta/report"]]),
    );

    expect(slugsOf(planned)).toEqual({ "@alpha/report": "alpha-report", "@zeta/report": "report" });
  });

  it("gives a fallback holder the same fallback, and the name once its holder left", () => {
    const agents = [view("@alpha/report"), view("@zeta/report")];
    const both = new Map([
      ["run-report", "@zeta/report"],
      ["run-alpha-report", "@alpha/report"],
    ]);
    expect(slugsOf(assignSlugs([], agents, both).planned)).toEqual({
      "@alpha/report": "run-alpha-report",
      "@zeta/report": "run-report",
    });

    const left = new Map([["run-alpha-report", "@alpha/report"]]);
    expect(slugsOf(assignSlugs([], [view("@alpha/report")], left).planned)).toEqual({
      "@alpha/report": "run-report",
    });
  });

  it("releases a name that is no longer one its holder would get", () => {
    // `@zed/tools` was installed as `pdf`, then renamed its frontmatter; it sorts
    // after the newcomer, so only an upfront check can free `pdf` in time.
    const { planned } = assignSlugs(
      [
        resolved({ packageId: "@acme/pdf", frontmatterName: "pdf" }),
        resolved({ packageId: "@zed/tools", frontmatterName: "tools" }),
      ],
      [],
      new Map([["pdf", "@zed/tools"]]),
    );

    expect(slugsOf(planned)).toEqual({ "@acme/pdf": "pdf", "@zed/tools": "tools" });
  });
});

describe("listSyncableAgents", () => {
  const agents: AgentFixture[] = [
    { id: "@acme/zebra", activeIn: ["spc_2"] },
    { id: "@appstrate/builtin", source: "system", activeIn: ["spc_2"] },
    { id: "@acme/alpha", activeIn: ["spc_2"] },
    { id: "@acme/elsewhere", activeIn: ["spc_1"] },
  ];

  it("lists the ACTIVE agents of the space it names, system ones included, sorted", async () => {
    // The profile pins spc_1: only the header can bring spc_2's agents back.
    createSkillServer([], undefined, agents).install();

    expect(await listSyncableAgents("default", "spc_2")).toEqual([
      { packageId: "@acme/alpha", system: false },
      { packageId: "@acme/zebra", system: false },
      { packageId: "@appstrate/builtin", system: true },
    ]);
  });
});

describe("resolveAgent", () => {
  it("pins the latest published version and carries the space's input layer", async () => {
    createSkillServer([], undefined, [
      {
        id: "@acme/report",
        display_name: "Weekly report",
        description: "Writes the report.",
        versions: ["1.0.0", "1.2.0"],
        input: { schema: { type: "object", properties: { topic: { type: "string" } } } },
        values: { topic: "sales" },
        locked_fields: ["topic"],
      },
    ]).install();

    expect(await resolveAgent("default", "@acme/report", "published", "spc_1")).toEqual({
      packageId: "@acme/report",
      spaceId: "spc_1",
      version: "1.2.0",
      title: "Weekly report",
      description: "Writes the report.",
      input: {
        schema: { type: "object", properties: { topic: { type: "string" } } },
        values: { topic: "sales" },
        locked_fields: ["topic"],
      },
    });
  });

  it("titles an agent with no display name by its package id", async () => {
    createSkillServer([], undefined, [{ id: "@acme/report", display_name: " " }]).install();

    const agent = (await resolveAgent("default", "@acme/report", "published", "spc_1"))!;
    expect(agent.title).toBe("@acme/report");
  });

  it("returns null — not an error — when the agent was never published", async () => {
    createSkillServer([], undefined, [{ id: "@acme/report", versions: [] }]).install();

    expect(await resolveAgent("default", "@acme/report", "published", "spc_1")).toBeNull();
  });

  it("names the draft and pins the command to it", async () => {
    createSkillServer([], undefined, [
      { id: "@acme/report", description: "Published.", draft: { description: "Working copy." } },
    ]).install();

    const agent = (await resolveAgent("default", "@acme/report", "draft", "spc_1"))!;
    expect(agent.version).toBe("draft");
    expect(agent.description).toBe("Working copy.");
  });

  it("says whose copy it is when the caller may not write the agent", async () => {
    createSkillServer([], undefined, [
      { id: "@acme/report", draft: { notWritable: true } },
    ]).install();

    const err = await resolveAgent("default", "@acme/report", "draft", "spc_1").then(
      () => null,
      (e: unknown) => e,
    );
    const rendered = formatError(err);
    expect(rendered).toContain("@acme/report");
    expect(rendered).toContain("author's working copy");
    expect(rendered).toContain("agents:write");
    expect(rendered).toContain("--source published");
  });
});

describe("fetchSkillFiles", () => {
  it("returns the archive entries of a published skill", async () => {
    createSkillServer([
      {
        id: "@acme/pdf",
        skillMd: skillMd("pdf"),
        extraFiles: { "reference/notes.md": "notes" },
      },
    ]).install();

    const skill = (await resolveSkill("default", "@acme/pdf", "published"))!;
    const files = await fetchSkillFiles("default", skill, "published");
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "manifest.json", "reference/notes.md"]);
  });

  it("refuses bytes that do not match the advertised integrity", async () => {
    createSkillServer([
      { id: "@acme/pdf", skillMd: skillMd("pdf"), corruptDownload: true },
    ]).install();

    const skill = (await resolveSkill("default", "@acme/pdf", "published"))!;
    await expect(fetchSkillFiles("default", skill, "published")).rejects.toThrow(
      /Integrity mismatch/,
    );
  });
});
