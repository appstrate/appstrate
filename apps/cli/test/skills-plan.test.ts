// SPDX-License-Identifier: Apache-2.0

/**
 * `lib/skills-sync/plan.ts` — catalogue reading (`GET /api/mcp/skills`),
 * pinning by served digests, slug assignment and the verified download
 * (`GET /api/mcp/skills/content`).
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
  listSyncableSkills,
  resolveSkill,
  type ResolvedSkill,
} from "../src/lib/skills-sync/plan.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { createSkillServer, skillMd } from "./helpers/skills-server.ts";

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
    spaceId: "spc_1",
    version: "1.0.0",
    integrity: "sha256:x",
    frontmatterName: "",
    entry: { uri: "", frontmatter: { name: "" }, resources: [] },
    ...overrides,
  };
}

const ids = (entries: { uri: string }[]) => entries.map((entry) => entry.uri.split("/")[4]);

/** The single entry the space lists at `source`. */
async function onlyEntry(source: "published" | "draft") {
  const [entry, ...rest] = await listSyncableSkills("default", "spc_1", source);
  expect(rest).toHaveLength(0);
  return entry!;
}

describe("listSyncableSkills", () => {
  it("reads the space's list and drops system packages", async () => {
    createSkillServer([
      { id: "@acme/zebra", skillMd: skillMd("zebra") },
      { id: "@appstrate/builtin", skillMd: skillMd("builtin") },
      { id: "@acme/alpha", skillMd: skillMd("alpha") },
    ]).install();

    expect(ids(await listSyncableSkills("default", "spc_1", "published"))).toEqual([
      "zebra",
      "alpha",
    ]);
  });

  // The sync reads what the space OFFERS, which is the ACTIVE set: a skill
  // somebody switched off in the space is not written into the local Claude
  // Code checkout, or the switch would mean nothing outside the dashboard.
  it("reads the ACTIVE set — a skill switched off in the space is not syncable", async () => {
    createSkillServer([
      { id: "@acme/on", skillMd: skillMd("on") },
      { id: "@acme/off", skillMd: skillMd("off"), inactive: true },
    ]).install();

    expect(ids(await listSyncableSkills("default", "spc_1", "published"))).toEqual(["on"]);
  });

  it("lists the drafts the caller may read for --source draft, published or not", async () => {
    createSkillServer([
      { id: "@acme/pdf", skillMd: skillMd("pdf"), draft: { skillMd: skillMd("pdf-next") } },
      { id: "@acme/new", skillMd: skillMd("new"), unpublished: true, draft: {} },
      { id: "@acme/theirs", skillMd: skillMd("theirs"), draft: { notWritable: true } },
    ]).install();

    const drafts = await listSyncableSkills("default", "spc_1", "draft");
    expect(drafts.map((entry) => entry.uri)).toEqual([
      "skill://spc_1/acme/pdf@draft/pdf-next/SKILL.md",
      "skill://spc_1/acme/new@draft/new/SKILL.md",
    ]);
  });
});

describe("resolveSkill", () => {
  it("labels a published skill with its served metadata.version and pins its digests", async () => {
    createSkillServer([
      { id: "@acme/pdf", skillMd: skillMd("pdf-tools", "Work with PDFs."), version: "2.3.1" },
    ]).install();

    const skill = resolveSkill(await onlyEntry("published"));
    expect(skill.packageId).toBe("@acme/pdf");
    expect(skill.spaceId).toBe("spc_1");
    expect(skill.version).toBe("2.3.1");
    expect(skill.frontmatterName).toBe("pdf-tools");
    expect(skill.integrity).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes the pin when a served digest changes, not when the version label does", async () => {
    createSkillServer([{ id: "@acme/pdf", skillMd: skillMd("pdf"), version: "1.0.0" }]).install();
    const first = resolveSkill(await onlyEntry("published"));
    createSkillServer([
      { id: "@acme/pdf", skillMd: skillMd("pdf"), extraFiles: { "a.md": "a" }, version: "1.0.0" },
    ]).install();
    const second = resolveSkill(await onlyEntry("published"));
    expect(second.integrity).not.toBe(first.integrity);
  });

  it('labels a draft "draft"', async () => {
    createSkillServer([
      { id: "@acme/pdf", skillMd: skillMd("pdf"), draft: { skillMd: skillMd("pdf-next") } },
    ]).install();

    const skill = resolveSkill(await onlyEntry("draft"));
    expect(skill.version).toBe("draft");
    expect(skill.frontmatterName).toBe("pdf-next");
  });

  it("refuses a published entry without metadata.version", () => {
    const uri = "skill://spc_1/acme/pdf/pdf/SKILL.md";
    const entry = {
      uri,
      frontmatter: { name: "pdf" },
      resources: [{ uri, digest: "sha256:00", size: 1 }],
    };
    expect(() => resolveSkill(entry)).toThrow(/metadata\.version/);
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
});

/** A ledger's `slug → holder`. */
function holding(pairs: [string, string][]) {
  return new Map(pairs.map(([slug, packageId]) => [slug, { packageId }]));
}

describe("assignSlugs — an installed name stays with its package", () => {
  const slugsOf = (planned: { packageId: string; slug: string }[]) =>
    Object.fromEntries(planned.map((entry) => [entry.packageId, entry.slug]));

  it("leaves a cycle where it is", () => {
    // Each holds the other's preferred name.
    const { planned } = assignSlugs(
      [
        resolved({ packageId: "@acme/one", frontmatterName: "one" }),
        resolved({ packageId: "@acme/two", frontmatterName: "two" }),
      ],
      holding([
        ["two", "@acme/one"],
        ["one", "@acme/two"],
      ]),
    );

    expect(slugsOf(planned)).toEqual({ "@acme/one": "two", "@acme/two": "one" });
  });

  it("moves a renamed holder to its new name and keeps its old one from others this run", () => {
    // `@zed/tools` was installed as `pdf`, then renamed its frontmatter to `tools`.
    const { planned } = assignSlugs(
      [
        resolved({ packageId: "@acme/pdf", frontmatterName: "pdf" }),
        resolved({ packageId: "@zed/tools", frontmatterName: "tools" }),
      ],
      holding([["pdf", "@zed/tools"]]),
    );

    expect(slugsOf(planned)).toEqual({ "@acme/pdf": "acme-pdf", "@zed/tools": "tools" });

    // Next run the ledger no longer holds `pdf`: it is the newcomer's to take.
    const next = assignSlugs(
      [
        resolved({ packageId: "@acme/pdf", frontmatterName: "pdf" }),
        resolved({ packageId: "@zed/tools", frontmatterName: "tools" }),
      ],
      holding([
        ["acme-pdf", "@acme/pdf"],
        ["tools", "@zed/tools"],
      ]),
    );
    expect(slugsOf(next.planned)).toEqual({ "@acme/pdf": "pdf", "@zed/tools": "tools" });
  });
});

describe("fetchSkillFiles", () => {
  it("returns every served file, by path inside the skill directory", async () => {
    createSkillServer([
      {
        id: "@acme/pdf",
        skillMd: skillMd("pdf"),
        extraFiles: { "reference/notes.md": "notes" },
        draft: { files: { "reference/notes.md": "draft notes" } },
      },
    ]).install();

    const files = await fetchSkillFiles("default", resolveSkill(await onlyEntry("published")));
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "reference/notes.md"]);
    expect(new TextDecoder().decode(files["reference/notes.md"]!)).toBe("notes");

    const draft = await fetchSkillFiles("default", resolveSkill(await onlyEntry("draft")));
    expect(new TextDecoder().decode(draft["reference/notes.md"]!)).toBe("draft notes");
  });

  it("refuses bytes that do not match the served digest", async () => {
    createSkillServer([
      { id: "@acme/pdf", skillMd: skillMd("pdf"), corruptDownload: true },
    ]).install();

    const skill = resolveSkill(await onlyEntry("published"));
    await expect(fetchSkillFiles("default", skill)).rejects.toThrow(
      /does not match its served digest/,
    );
  });
});
