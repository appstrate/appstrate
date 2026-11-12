// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP Skills extension (SEP-2640) with the read injected: the served Agent Skills directory (normalized `SKILL.md`, digests, limits),
 * and `skills/list` / `skills/get` / `resources/read` over a real MCP client.
 * Access itself is `services/skill-read.ts`, covered by the integration suite.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createInProcessPair } from "@appstrate/mcp-transport";
import type { SkillEntry } from "@appstrate/core/skill-uri";
import { normalizeSkillMd, parseSkillFrontmatter } from "@appstrate/afps-shared/companion-files";
import { forbidden } from "../../../../src/lib/errors.ts";
import {
  serveSkill,
  SKILL_MAX_FILES,
  skillName,
} from "../../../../src/modules/mcp/skill-resources.ts";
import { buildSkillServer, type SkillProviderContext } from "../../../../src/modules/mcp/skills.ts";
import type { SkillSnapshot } from "../../../../src/services/skill-read.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const SPACE = "spc_1";

describe("serveSkill", () => {
  const md = (name: string) =>
    `---\nname: ${name}\ndescription: Sets the tone.\nx-extra: kept\n---\nBody $& $1\n`;

  it("drops packaging entries, keeps every other file as stored", () => {
    const script = new Uint8Array([0, 255, 1]);
    const served = serveSkill(
      "@acme/tone",
      {
        "SKILL.md": encode(md("tone")),
        "manifest.json": encode("{}"),
        RECORD: encode("sig"),
        "scripts/run.bin": script,
      },
      null,
    );
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
    const served = serveSkill("@acme/tone-kit", { "SKILL.md": encode(md("Tone Kit")) }, null);
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    expect(served.skill.name).toBe("tone-kit");
    const text = new TextDecoder().decode(served.skill.files["SKILL.md"]);
    expect(text).toBe(md("tone-kit"));
    // The entry's frontmatter is the served SKILL.md's.
    expect(parseSkillFrontmatter(text).fields).toEqual(served.skill.frontmatter);
  });

  it("writes the version in metadata.version, read back into the entry's frontmatter", () => {
    const served = serveSkill("@acme/tone", { "SKILL.md": encode(md("tone")) }, "2.1.0");
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    const text = new TextDecoder().decode(served.skill.files["SKILL.md"]);
    expect(text).toBe(
      "---\nname: tone\ndescription: Sets the tone.\nx-extra: kept\nmetadata:\n  version: 2.1.0\n---\nBody $& $1\n",
    );
    expect(served.skill.frontmatter.metadata).toEqual({ version: "2.1.0" });
    expect(parseSkillFrontmatter(text).fields).toEqual(served.skill.frontmatter);
  });

  it("drops an authored metadata.version from a draft and keeps the other metadata", () => {
    const authored =
      "---\nname: tone\ndescription: d\nmetadata:\n  author: me\n  version: 9.9.9\n---\n";
    const served = serveSkill("@acme/tone", { "SKILL.md": encode(authored) }, null);
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    expect(served.skill.frontmatter.metadata).toEqual({ author: "me" });
  });

  it("serves a file of any size within the spec's total", () => {
    const big = new Uint8Array(2 * 1024 * 1024);
    const served = serveSkill("@acme/tone", { "SKILL.md": encode(md("tone")), "a.bin": big }, null);
    expect(served.ok).toBe(true);
  });

  it("counts the normalized SKILL.md against the total", () => {
    const authored = encode(md("tone"));
    const filler = new Uint8Array(16 * 1024 * 1024 - authored.byteLength);
    const stored = { "SKILL.md": authored, "a.bin": filler };
    expect(serveSkill("@acme/tone", stored, null).ok).toBe(true);
    expect(serveSkill("@acme/tone", stored, "1.0.0").ok).toBe(false);
  });

  it("refuses a tree it cannot serve whole", () => {
    const total = 16 * 1024 * 1024;
    expect(
      serveSkill(
        "@acme/tone",
        { "SKILL.md": encode(md("tone")), "a.bin": new Uint8Array(total + 1) },
        null,
      ).ok,
    ).toBe(false);
    const many: Record<string, Uint8Array> = { "SKILL.md": encode(md("tone")) };
    for (let i = 0; i < SKILL_MAX_FILES; i += 1) many[`f/${i}`] = encode("x");
    expect(serveSkill("@acme/tone", many, null).ok).toBe(false);
    expect(serveSkill("@acme/tone", { "README.md": encode("x") }, null).ok).toBe(false);
    expect(
      serveSkill("@acme/tone", { "SKILL.md": encode("---\nname: tone\n---\n") }, null).ok,
    ).toBe(false);
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
      spaceIds: [SPACE],
      listActiveSkillIds: async () => ["@acme/tone", "@acme/hidden"],
      readSkill: async (_spaceId, packageId, definition) => {
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
      expect(entry!.frontmatter).toEqual({
        name: "tone",
        description: "Sets the tone.",
        metadata: { version: "1.0.0" },
      });
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
      const [md] = (await p.client.readResource({ uri: entry!.uri })).contents;
      const text = (md as { text?: unknown } | undefined)?.text;
      expect(typeof text).toBe("string");
      expect(parseSkillFrontmatter(String(text)).fields).toEqual(entry!.frontmatter);
    } finally {
      await p.close();
    }
  });

  it("lists the drafts the caller may read at their @draft URIs, without a version", async () => {
    const definitions: string[] = [];
    const s = server({
      listActiveSkillIds: async (_spaceId, definition) => {
        definitions.push(definition);
        return ["@acme/tone", "@acme/hidden"];
      },
    });
    const drafts = await s.list("draft");
    expect(definitions).toEqual(["draft"]);
    expect(drafts.map((entry) => entry.uri)).toEqual([
      "skill://spc_1/acme/tone@draft/tone/SKILL.md",
    ]);
    expect(drafts[0]!.frontmatter.metadata).toBeUndefined();
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
      readSkill: async (_spaceId, packageId, definition) =>
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

  it("lists and reads every space reached, each with its own read", async () => {
    const reads: string[] = [];
    const s = server({
      spaceIds: [SPACE, "spc_2"],
      listActiveSkillIds: async (spaceId) => (spaceId === SPACE ? ["@acme/tone"] : ["@acme/voice"]),
      readSkill: async (spaceId, packageId, definition) => {
        reads.push(`${spaceId} ${packageId}`);
        return spaceId === "spc_2" && packageId === "@acme/tone"
          ? null
          : snapshot(packageId, definition);
      },
    });
    const p = await pair(s);
    try {
      const list = await p.client.request({ method: "skills/list", params: {} }, ResultSchema);
      expect((list.skills as SkillEntry[]).map((entry) => entry.uri)).toEqual([
        "skill://spc_1/acme/tone/tone/SKILL.md",
        "skill://spc_2/acme/voice/tone/SKILL.md",
      ]);
      expect(reads).toEqual(["spc_1 @acme/tone", "spc_2 @acme/voice"]);
      const read = await p.client.readResource({ uri: "skill://spc_2/acme/voice/tone/SKILL.md" });
      expect(read.contents).toHaveLength(1);
      // A skill readable in one space is not readable through another space's URI.
      const err = await p.client
        .readResource({ uri: "skill://spc_2/acme/tone/tone/SKILL.md" })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toMatchObject({ code: -32002 });
      expect(reads.at(-1)).toBe("spc_2 @acme/tone");
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
