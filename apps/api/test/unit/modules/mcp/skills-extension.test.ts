// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP Skills extension (SEP-2640) with the read injected: `skill://` URIs,
 * the served Agent Skills directory (normalized `SKILL.md`, digests, limits),
 * and `skills/list` / `skills/get` / `resources/read` over a real MCP client.
 * Access itself is `services/skill-read.ts`, covered by the integration suite.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createInProcessPair, type SkillEntry } from "@appstrate/mcp-transport";
import { parseSkillFrontmatter } from "@appstrate/afps-shared/companion-files";
import { forbidden } from "../../../../src/lib/errors.ts";
import {
  normalizeSkillMd,
  parseSkillUri,
  serveSkill,
  SKILL_FILE_MAX_BYTES,
  SKILL_MAX_FILES,
  skillFileUri,
  skillName,
} from "../../../../src/modules/mcp/skill-resources.ts";
import { buildSkillServer, type SkillProviderContext } from "../../../../src/modules/mcp/skills.ts";
import type { SkillSnapshot } from "../../../../src/services/skill-read.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const SPACE = "spc_1";

describe("skill:// URIs", () => {
  it("round-trips the published and the draft form, the name before SKILL.md", () => {
    const published = {
      spaceId: SPACE,
      packageId: "@acme/tone-kit",
      name: "tone",
      path: "SKILL.md",
    };
    const uri = skillFileUri({ ...published, definition: "published" });
    expect(uri).toBe("skill://spc_1/acme/tone-kit/tone/SKILL.md");
    expect(parseSkillUri(uri)).toEqual({ ...published, definition: "published" });
    const draft = skillFileUri({ ...published, definition: "draft", path: "refs/a b.md" });
    expect(draft).toBe("skill://spc_1/acme/tone-kit@draft/tone/refs/a%20b.md");
    expect(parseSkillUri(draft)).toEqual({
      ...published,
      definition: "draft",
      path: "refs/a b.md",
    });
  });

  it("reads a published skill named `draft` as published", () => {
    expect(parseSkillUri("skill://spc_1/acme/kit/draft/x/SKILL.md")).toMatchObject({
      definition: "published",
      name: "draft",
      path: "x/SKILL.md",
    });
  });

  it("refuses other schemes, missing segments, traversal and invalid names", () => {
    for (const uri of [
      "appfile://file_1",
      "skill://spc_1/acme/kit/SKILL.md",
      "skill://spc_1/acme/kit/tone/../x",
      "skill://spc_1/acme/kit/tone/%2e%2e/x",
      "skill://spc_1/acme/kit/Tone/SKILL.md",
      "skill://spc_1/acme/kit/tone//SKILL.md",
    ]) {
      expect(parseSkillUri(uri)).toBeNull();
    }
  });
});

describe("serveSkill", () => {
  const md = (name: string) =>
    `---\nname: ${name}\ndescription: Sets the tone.\nx-extra: kept\n---\nBody $& $1\n`;

  it("drops packaging entries, keeps every other file as stored", () => {
    const script = new Uint8Array([0, 255, 1]);
    const served = serveSkill("@acme/tone", {
      "SKILL.md": encode(md("tone")),
      "manifest.json": encode("{}"),
      RECORD: encode("sig"),
      "scripts/run.bin": script,
    });
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    expect(Object.keys(served.skill.files)).toEqual(["SKILL.md", "scripts/run.bin"]);
    expect(served.skill.files["scripts/run.bin"]).toBe(script);
    expect(served.skill.frontmatter).toEqual({
      name: "tone",
      description: "Sets the tone.",
      "x-extra": "kept",
    });
  });

  it("names an invalid frontmatter name after the package and rewrites only that line", () => {
    const served = serveSkill("@acme/tone-kit", { "SKILL.md": encode(md("Tone Kit")) });
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    expect(served.skill.name).toBe("tone-kit");
    const text = new TextDecoder().decode(served.skill.files["SKILL.md"]);
    expect(text).toBe(md("tone-kit"));
    // The entry's frontmatter is the served SKILL.md's.
    expect(served.skill.frontmatter).toEqual(parseSkillFrontmatter(text).fields);
  });

  it("refuses a tree it cannot serve whole", () => {
    const big = new Uint8Array(SKILL_FILE_MAX_BYTES + 1);
    expect(serveSkill("@acme/tone", { "SKILL.md": encode(md("tone")), "a.bin": big }).ok).toBe(
      false,
    );
    const many: Record<string, Uint8Array> = { "SKILL.md": encode(md("tone")) };
    for (let i = 0; i < SKILL_MAX_FILES; i += 1) many[`f/${i}`] = encode("x");
    expect(serveSkill("@acme/tone", many).ok).toBe(false);
    expect(serveSkill("@acme/tone", { "README.md": encode("x") }).ok).toBe(false);
    expect(serveSkill("@acme/tone", { "SKILL.md": encode("---\nname: tone\n---\n") }).ok).toBe(
      false,
    );
  });

  it("keeps the normalization rules: valid name wins, `$` sequences untouched, name inserted", () => {
    expect(skillName("tone", "other")).toBe("tone");
    expect(skillName("Not Valid", "Tone Kit")).toBe("tone-kit");
    expect(skillName("", "")).toBeNull();
    expect(normalizeSkillMd("---\r\ndescription: d\r\nx: y\r\n---\r\n", "tone")).toBe(
      "---\r\nname: tone\r\ndescription: d\r\nx: y\r\n---\r\n",
    );
    expect(normalizeSkillMd("no frontmatter", "tone")).toBe("no frontmatter");
  });
});

describe("skills/list, skills/get and resources/read", () => {
  const skillMd = encode("---\nname: tone\ndescription: Sets the tone.\n---\nBody\n");
  const binary = new Uint8Array([0xff, 0xfe, 0x00]);
  const bom = encode("\uFEFFwith bom");

  function snapshot(packageId: string, definition: "published" | "draft"): SkillSnapshot {
    return {
      packageId,
      version: definition === "draft" ? null : "1.0.0",
      definition,
      snapshot: {
        files: { "SKILL.md": skillMd, "data.bin": binary, "refs/bom.txt": bom },
        snapshotId: "s",
      },
    };
  }

  function server(overrides: Partial<SkillProviderContext> = {}) {
    const unservable: string[] = [];
    const ctx: SkillProviderContext = {
      spaceId: SPACE,
      listActiveSkillIds: async () => ["@acme/tone", "@acme/hidden"],
      readSkill: async (packageId, definition) => {
        if (packageId === "@acme/hidden") throw forbidden("no");
        return snapshot(packageId, definition);
      },
      logUnservable: (event) => unservable.push(event.packageId),
      ...overrides,
    };
    return { ...buildSkillServer(ctx), unservable };
  }

  async function pair(s: ReturnType<typeof server>) {
    return createInProcessPair([], {
      resources: { read: (uri) => s.read(uri) },
      skills: s.provider,
    });
  }

  it("lists what the caller may read, every digest verifiable against resources/read", async () => {
    const s = server();
    const p = await pair(s);
    try {
      const list = await p.client.request({ method: "skills/list", params: {} }, ResultSchema);
      const skills = list.skills as SkillEntry[];
      expect(skills.map((entry) => entry.uri)).toEqual(["skill://spc_1/acme/tone/tone/SKILL.md"]);
      const [entry] = skills;
      expect(entry!.frontmatter).toEqual({ name: "tone", description: "Sets the tone." });
      for (const resource of entry!.resources) {
        const read = await p.client.readResource({ uri: resource.uri });
        const content = read.contents[0]!;
        const bytes =
          "text" in content
            ? encode(content.text as string)
            : new Uint8Array(Buffer.from(content.blob as string, "base64"));
        expect(sha256(bytes)).toBe(resource.digest);
        expect(bytes.byteLength).toBe(resource.size);
      }
      const md = await p.client.readResource({ uri: entry!.uri });
      expect(parseSkillFrontmatter(md.contents[0]!.text as string).fields).toEqual(
        entry!.frontmatter,
      );
    } finally {
      await p.close();
    }
  });

  it("serves an unlisted draft by its @draft URI through skills/get", async () => {
    const s = server();
    const p = await pair(s);
    try {
      const uri = "skill://spc_1/acme/tone@draft/tone/SKILL.md";
      const get = await p.client.request({ method: "skills/get", params: { uri } }, ResultSchema);
      expect((get.skill as SkillEntry).uri).toBe(uri);
    } finally {
      await p.close();
    }
  });

  it("refuses a refused, mismatched, other-space or unservable skill", async () => {
    const s = server({
      readSkill: async (packageId, definition) =>
        packageId === "@acme/big"
          ? { ...snapshot(packageId, definition), snapshot: { files: {}, snapshotId: "s" } }
          : packageId === "@acme/pinned"
            ? snapshot(packageId, "draft")
            : null,
      listActiveSkillIds: async () => ["@acme/big", "@acme/pinned", "@acme/gone"],
    });
    const p = await pair(s);
    try {
      const list = await p.client.request({ method: "skills/list", params: {} }, ResultSchema);
      expect(list.skills).toEqual([]);
      expect(s.unservable).toEqual(["@acme/big"]);
      for (const uri of [
        "skill://spc_1/acme/gone/tone/SKILL.md",
        "skill://spc_1/acme/pinned/tone/SKILL.md",
        "skill://spc_2/acme/tone/tone/SKILL.md",
        "skill://spc_1/acme/big/tone/SKILL.md",
      ]) {
        const err = await p.client
          .request({ method: "skills/get", params: { uri } }, ResultSchema)
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(err).toMatchObject({ code: -32602 });
        const readErr = await p.client.readResource({ uri }).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(readErr).toMatchObject({ code: -32002 });
      }
    } finally {
      await p.close();
    }
  });

  it("refuses a URI whose name segment is not the served name", async () => {
    const s = server();
    const p = await pair(s);
    try {
      const err = await p.client
        .readResource({ uri: "skill://spc_1/acme/tone/other/SKILL.md" })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toMatchObject({ code: -32002 });
    } finally {
      await p.close();
    }
  });
});
