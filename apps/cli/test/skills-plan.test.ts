// SPDX-License-Identifier: Apache-2.0

/**
 * `lib/skills-sync/plan.ts` — catalogue reading, version pinning, slug
 * assignment and the verified download.
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
  // The stub only narrows when the request carries `?active=true`, so dropping
  // the parameter turns this red.
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
          fetchedFiles: { "reference/notes.md": "draft notes" },
        },
      },
    ]).install();

    const skill = (await resolveSkill("default", "@acme/pdf", "draft"))!;
    expect(skill.version).toBe("draft");
    expect(skill.integrity).toBe('draft:1:"idx-9"');
    // The two fixtures carry DIFFERENT frontmatter names, so this pins the
    // selector on the detail request the same way the bytes below pin it on
    // the file routes: unnamed, the stub answers with the published metadata.
    expect(skill.frontmatterName).toBe("pdf-tools-draft");

    const files = await fetchSkillFiles("default", skill, "draft");
    const decoder = new TextDecoder();
    expect(decoder.decode(files["SKILL.md"]!)).toContain("Working copy.");
    // Fetched separately, so this one pins the selector on `/files/content`.
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

  it("explains the same refusal when it lands on a file download", async () => {
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
      draftIndex: [{ path: "reference/notes.md" }],
    });
    const err = await fetchSkillFiles("default", skill, "draft").then(
      () => null,
      (e: unknown) => e,
    );
    expect(formatError(err)).toContain("reference/notes.md");
    expect(formatError(err)).toContain("--source published");
  });
});

describe("assignSlugs", () => {
  it("gives the short slug to the first claimant and renames the rest", () => {
    const planned = assignSlugs([
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

    expect(assignSlugs([b, a]).map((s) => s.slug)).toEqual(["pdf-tools", "acme-pdf-tools"]);
  });

  it("never hands two skills the same directory when the fallback itself collides", () => {
    // `@a/b` reduces to `acme-foo` through its FRONTMATTER, and both
    // `@acme/bar` and `@acme/foo` reduce to `acme-foo` through the
    // `<scope>-<name>` fallback. Three claimants, three directories.
    const planned = assignSlugs([
      resolved({ packageId: "@a/b", frontmatterName: "acme-foo" }),
      resolved({ packageId: "@acme/bar", frontmatterName: "foo" }),
      resolved({ packageId: "@acme/foo", frontmatterName: "foo" }),
    ]);

    const slugs = planned.map((s) => s.slug);
    expect(slugs).toEqual(["acme-foo", "foo", "acme-foo-2"]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("falls back to the package name segment when the frontmatter name is absent", () => {
    const planned = assignSlugs([resolved({ packageId: "@acme/weekly-report" })]);
    expect(planned[0]?.slug).toBe("weekly-report");
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
