// SPDX-License-Identifier: Apache-2.0

/**
 * `lib/skills-sync/plan.ts` — catalogue reading (`GET /api/mcp/skills`),
 * pinning by served digests, slug assignment and the verified download
 * (`GET /api/mcp/skills/archive`).
 *
 * `globalThis.fetch` is stubbed with the shared skill server
 * (`helpers/skills-server.ts`) rather than injected: the CLI's whole auth
 * pipeline (`lib/api.ts`) sits between these functions and the network, and
 * routing around it would test a shorter path than production takes.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SKILL_MAX_FILES, SKILL_MAX_TOTAL_BYTES } from "@appstrate/core/skill-uri";
import { zipArtifact } from "@appstrate/core/zip";
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
    entry: { uri: "", frontmatter: { name: "", description: "" }, resources: [] },
    ...overrides,
  };
}

const DIGEST = `sha256:${"0".repeat(64)}`;

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
      frontmatter: { name: "pdf", description: "d" },
      resources: [{ uri, digest: DIGEST, size: 1 }],
    };
    expect(() => resolveSkill(entry)).toThrow(/metadata\.version/);
  });

  it("refuses an entry naming a path outside its directory, a duplicate or an invalid name", () => {
    const dir = "skill://spc_1/acme/pdf@draft/pdf";
    const skillMdUri = `${dir}/SKILL.md`;
    const file = (uri: string) => ({ uri, digest: DIGEST, size: 1 });
    const entry = (uri: string, name: string, extra: string[]) => ({
      uri,
      frontmatter: { name, description: "d" },
      resources: [file(uri), ...extra.map(file)],
    });
    for (const hostile of [
      entry(skillMdUri, "pdf", [`${dir}/../../x`]),
      entry(skillMdUri, "pdf", [`${dir}/%2E%2E/x`]),
      entry(skillMdUri, "pdf", [`${dir}/refs%2F..%2F..%2Fx`]),
      entry(skillMdUri, "pdf", [`${dir}/%2Fetc/passwd`]),
      entry(skillMdUri, "pdf", [`${dir}/refs/`]),
      entry(skillMdUri, "pdf", [skillMdUri]),
      entry(skillMdUri, "pdf", ["skill://spc_1/acme/other@draft/pdf/a.md"]),
      entry(skillMdUri, "pdf", ["skill://spc_2/acme/pdf@draft/pdf/a.md"]),
      entry(skillMdUri, "../pdf", []),
      entry("skill://spc_1/acme/pdf@draft/Pdf/SKILL.md", "Pdf", []),
      entry(`${dir}/a.md`, "pdf", []),
    ]) {
      expect(() => resolveSkill(hostile)).toThrow(/Malformed skill entry/);
    }
    expect(resolveSkill(entry(skillMdUri, "pdf", [`${dir}/refs/a%20b.md`])).version).toBe("draft");
  });

  // The sizes bound the archive download: each must be a byte count, and the
  // whole within the SEP-2640 limits, before the CLI relies on them.
  it("refuses sizes and digests that are not usable, and an entry over the SEP-2640 limits", () => {
    const dir = "skill://spc_1/acme/pdf@draft/pdf";
    const skillMdUri = `${dir}/SKILL.md`;
    const entry = (resources: { uri: string; digest: unknown; size: unknown }[]) =>
      ({
        uri: skillMdUri,
        frontmatter: { name: "pdf", description: "d" },
        resources: [{ uri: skillMdUri, digest: DIGEST, size: 1 }, ...resources],
      }) as Parameters<typeof resolveSkill>[0];
    const file = (size: unknown, digest: unknown = DIGEST) => ({
      uri: `${dir}/a.md`,
      digest,
      size,
    });
    for (const hostile of [
      entry([file("1")]),
      entry([file(-1)]),
      entry([file(1.5)]),
      entry([file(Number.MAX_SAFE_INTEGER + 1)]),
      entry([file(1, "sha256:00")]),
      entry([file(1, `sha256:${"A".repeat(64)}`)]),
      entry([file(1, 42)]),
      entry([file(SKILL_MAX_TOTAL_BYTES)]),
      entry(
        Array.from({ length: SKILL_MAX_FILES }, (_, i) => ({
          uri: `${dir}/f${i}.md`,
          digest: DIGEST,
          size: 1,
        })),
      ),
    ]) {
      expect(() => resolveSkill(hostile)).toThrow(/Malformed skill entry/);
    }
    expect(resolveSkill(entry([file(SKILL_MAX_TOTAL_BYTES - 1)])).version).toBe("draft");
  });

  it("refuses two paths that are one file on a case- or normalization-insensitive disk", () => {
    const dir = "skill://spc_1/acme/pdf@draft/pdf";
    const skillMdUri = `${dir}/SKILL.md`;
    const entry = (paths: string[]) => ({
      uri: skillMdUri,
      frontmatter: { name: "pdf", description: "d" },
      resources: [skillMdUri, ...paths.map((path) => `${dir}/${encodeURIComponent(path)}`)].map(
        (uri) => ({ uri, digest: DIGEST, size: 1 }),
      ),
    });
    expect(() => resolveSkill(entry(["skill.md"]))).toThrow(/listed twice/);
    expect(() => resolveSkill(entry(["caf\u00e9.md", "cafe\u0301.md"]))).toThrow(/listed twice/);
    expect(resolveSkill(entry(["notes.md"])).version).toBe("draft");
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

  it("reads a skill of more than 50 files in one request", async () => {
    const extraFiles: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) extraFiles[`refs/${i}.md`] = `file ${i}`;
    const server = createSkillServer([{ id: "@acme/pdf", skillMd: skillMd("pdf"), extraFiles }]);
    server.install();
    const served = globalThis.fetch;
    let archiveReads = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/mcp/skills/archive") archiveReads += 1;
      return served(input, init);
    }) as unknown as typeof fetch;

    const files = await fetchSkillFiles("default", resolveSkill(await onlyEntry("published")));
    expect(Object.keys(files)).toHaveLength(61);
    expect(new TextDecoder().decode(files["refs/59.md"]!)).toBe("file 59");
    expect(archiveReads).toBe(1);
  });

  it("refuses an archive that does not hold exactly the entry's files", async () => {
    createSkillServer([
      { id: "@acme/pdf", skillMd: skillMd("pdf"), extraFiles: { "notes.md": "notes" } },
    ]).install();
    const skill = resolveSkill(await onlyEntry("published"));
    const served = globalThis.fetch;
    const original = await fetchSkillFiles("default", skill);
    const serveArchive = (files: Record<string, Uint8Array>) => {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
        new URL(String(input)).pathname === "/api/mcp/skills/archive"
          ? new Response(new Uint8Array(zipArtifact(files)), {
              headers: { "Content-Type": "application/zip" },
            })
          : served(input, init)) as unknown as typeof fetch;
    };
    const encode = (text: string) => new TextEncoder().encode(text);
    for (const hostile of [
      { ...original, "extra.md": encode("x") },
      { "SKILL.md": original["SKILL.md"]!, "../notes.md": original["notes.md"]! },
      { ...original, "notes.md": encode("notes, longer than listed") },
      { ...original, "notes.md": encode("n") },
    ]) {
      serveArchive(hostile);
      await expect(fetchSkillFiles("default", skill)).rejects.toThrow(
        /does not match its served digests/,
      );
    }
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

  it("refuses a SKILL.md whose frontmatter differs from its entry's", async () => {
    createSkillServer([{ id: "@acme/pdf", skillMd: skillMd("pdf"), version: "1.0.0" }]).install();

    const skill = resolveSkill(await onlyEntry("published"));
    expect(Object.keys(await fetchSkillFiles("default", skill))).toContain("SKILL.md");
    const altered = { ...skill.entry.frontmatter, description: "Something else." };
    await expect(
      fetchSkillFiles("default", { ...skill, entry: { ...skill.entry, frontmatter: altered } }),
    ).rejects.toThrow(/does not match the frontmatter of its entry/);
  });

  // The entry reaches the CLI as JSON, which has no spelling for these YAML values.
  it("accepts frontmatter values that JSON spells differently (.inf, .nan, -0)", async () => {
    const md = "---\nname: pdf\ndescription: d\nx-max: .inf\nx-nan: .nan\nx-zero: -0\n---\nBody.\n";
    createSkillServer([{ id: "@acme/pdf", skillMd: md }]).install();

    const skill = resolveSkill(await onlyEntry("published"));
    expect(Object.keys(await fetchSkillFiles("default", skill))).toContain("SKILL.md");
  });
});

describe("listSyncableSkills — what the list route answers", () => {
  function serveList(response: () => Response): void {
    createSkillServer([{ id: "@acme/pdf", skillMd: skillMd("pdf") }]).install();
    const served = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/mcp/skills"
        ? response()
        : served(input, init)) as unknown as typeof fetch;
  }

  // Kept so that it reaches `resolveSkill` and is reported as refused, which
  // keeps the skill its package installed, instead of vanishing from the catalogue.
  it("keeps an entry whose URI does not parse but names a package", async () => {
    const uri = "skill://spc_1/acme/pdf/Not_Valid/SKILL.md";
    const entry = { uri, frontmatter: { name: "Not_Valid", description: "d" }, resources: [] };
    serveList(() => Response.json({ object: "list", data: [entry], hasMore: false }));

    const [listed] = await listSyncableSkills("default", "spc_1", "published");
    expect(listed!.uri).toBe(uri);
    expect(() => resolveSkill(listed!)).toThrow(/Malformed skill entry/);
  });

  it("explains a 404: the instance may not run the mcp module", async () => {
    serveList(() =>
      Response.json({ code: "not_found", detail: "API endpoint not found" }, { status: 404 }),
    );

    await expect(listSyncableSkills("default", "spc_1", "published")).rejects.toThrow(
      /answered 404/,
    );
    const error = await listSyncableSkills("default", "spc_1", "published").catch((e) => e);
    expect((error as { hint?: string }).hint).toMatch(/mcp module/);
  });
});
