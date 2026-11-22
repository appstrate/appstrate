// SPDX-License-Identifier: Apache-2.0

/**
 * The chat injects a "## Your context" block into the system prompt so the agent knows who it
 * is acting for, their role, the space the conversation was opened in and the skills it follows. `formatCallerContext` renders that block from the
 * caller's identity; `buildCallerContextBlock` reads the skills over a platform connection.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  formatCallerContext,
  buildCallerContextBlock,
  type ChatSkillsClient,
} from "../src/prompt.ts";
import { turnCapabilities } from "../src/capabilities.ts";
import { DEFAULT_SKILL_SELECTION } from "../src/skills.ts";
import {
  SKILL_DEFINITION_META_KEY,
  SKILL_LOCK_VERSION_META_KEY,
  type SkillEntry,
} from "@appstrate/core/skill-uri";
import { callerIdentity } from "./caller-identity.ts";
import { reachableSpace } from "./reachable-space.ts";

/** The rendered texts; the injected-skills claim has its own cases. */
const contextText = (...args: Parameters<typeof identityContext>) => identityContext(...args).text;

/** `formatCallerContext` over an identity given loosely: what is not named is not known. */
function identityContext(
  raw: Parameters<typeof callerIdentity>[0],
  opts: Parameters<typeof formatCallerContext>[1],
) {
  return formatCallerContext(callerIdentity(raw), opts);
}
const blockText = async (...args: Parameters<typeof buildCallerContextBlock>) =>
  (await buildCallerContextBlock(...args)).text;

/** Minimal Hono-context stub exposing the `c.get(key)` reads the builder makes. */

function fakeContext(vars: Record<string, unknown>): any {
  return { get: (k: string) => vars[k] };
}

/** The turn's capabilities, from the permission set a role actually grants. */
function caps(permissions: readonly string[]) {
  return turnCapabilities((permission) => permissions.includes(permission), []);
}

/** A builder: the MCP pair, the launch, run-read and authoring. */
const BUILDER = [
  "mcp:read",
  "mcp:invoke",
  "agents:run",
  "agents:write",
  "runs:read",
  "skills:read",
];
/** The same caller without any `skills:*`. */
const WITHOUT_SKILLS = BUILDER.filter((permission) => !permission.startsWith("skills:"));
/** The same caller with the authoring toggle off (or a persona without it). */
const NO_AUTHORING = BUILDER.filter((permission) => permission !== "agents:write");

/** The one space the builder reaches, with the grants that make it part of the acting set. */
const REACH = [
  reachableSpace({
    id: "spc_1",
    name: "One",
    role: "builder",
    permissions: ["chat:read", "chat:write", ...BUILDER],
    credentialProxyOpen: true,
  }),
];

/**
 * Opts every case shares; a case that is ABOUT one of them overrides it. The
 * permission-shaped fields are required, so a literal per call would be noise
 * the reader has to diff.
 */
const BASE_OPTS = {
  capabilities: caps(BUILDER),
  rolePreview: false,
  restricted: false,
  permissions: ["agents:read", "mcp:invoke"],
  skills: DEFAULT_SKILL_SELECTION,
} as const;

/** A line of the catalogue: the published entry of `@<scope>/<name>`, or its draft. */
const listedSkill = (packageId: string, description: string, version: string | null = null) => {
  const [scope, name] = packageId.slice(1).split("/");
  return {
    packageId,
    name,
    description,
    version,
    uri: `skill://space-1/${scope}/${name}${version ? "" : "@draft"}/${name}/SKILL.md`,
  };
};

describe("formatCallerContext", () => {
  it("lists skills whatever the turn's authoring grant — the chat loads them itself", () => {
    const raw = { user: { name: "Ada" }, org: { role: "member" } };
    for (const permissions of [BUILDER, NO_AUTHORING]) {
      const out = contextText(raw, {
        ...BASE_OPTS,
        capabilities: caps(permissions),
        skillCatalogue: [listedSkill("@acme/research", "Research")],
      });
      expect(out).toContain("## Skills");
      expect(out).toContain("`@acme/research`");
    }
  });

  it("injects the pinned skills in full, in stored order, tagged with id and version, with discovery on or off", () => {
    const raw = { user: { name: "Ada" }, org: { role: "member" } };
    const skillCatalogue = [listedSkill("@acme/pdf", "PDF")];
    const skillContents = new Map([
      [
        "@acme/zeta",
        {
          packageId: "@acme/zeta",
          uri: "skill://space-1/acme/zeta/zeta/SKILL.md",
          version: "1.0.0",
          served: { definition: "published", version: "1.0.0" },
          content: "---\nname: zeta\n---\nZeta body.",
        },
      ],
      [
        "@acme/mine",
        {
          packageId: "@acme/mine",
          uri: "skill://space-1/acme/mine/mine/SKILL.md",
          version: "1.0.0",
          served: { definition: "published", version: "1.0.0" },
          content: "Mine body.\n",
        },
      ],
    ]);
    // A turn without discovery holds no `skills:read`: the injected skills need no tool.
    for (const [skillDiscovery, permissions] of [
      [true, BUILDER],
      [false, BUILDER.filter((p) => p !== "skills:read")],
    ] as const) {
      const out = contextText(raw, {
        ...BASE_OPTS,
        capabilities: caps(permissions),
        skills: { skillDiscovery, pinnedSkills: ["@acme/mine", "@acme/zeta"] },
        skillContents,
        skillCatalogue,
      });
      expect(out.split("## Skills")).toHaveLength(2);
      expect(out).toContain(
        "These skills are pinned to this conversation, by the user or by your own earlier load.",
      );
      expect(out).toContain(
        '<skill id="@acme/mine" uri="skill://space-1/acme/mine/mine/SKILL.md" version="1.0.0">\nMine body.\n</skill>',
      );
      expect(out).toContain(
        '<skill id="@acme/zeta" uri="skill://space-1/acme/zeta/zeta/SKILL.md" version="1.0.0">\n---\nname: zeta\n---\nZeta body.\n</skill>',
      );
      expect(out.indexOf("@acme/mine")).toBeLessThan(out.indexOf("@acme/zeta"));
      // The catalogue sits next to the pinned skills with discovery on, and nowhere without.
      expect(out.includes("- `@acme/pdf`")).toBe(skillDiscovery);
    }
  });

  it("lists the catalogue without the pinned skills, which are injected instead", () => {
    const mine = {
      packageId: "@acme/mine",
      uri: "skill://space-1/acme/mine/mine/SKILL.md",
      version: "1.0.0",
      served: { definition: "published", version: "1.0.0" } as const,
      content: "Mine body.",
    };
    const out = contextText(
      { user: { name: "Ada" }, org: { role: "member" } },
      {
        ...BASE_OPTS,
        skills: { skillDiscovery: true, pinnedSkills: ["@acme/mine"] },
        skillContents: new Map([["@acme/mine", mine]]),
        skillCatalogue: [
          listedSkill("@acme/mine", "Mine", "1.0.0"),
          listedSkill("@acme/pdf", "PDF", "1.0.0"),
        ],
      },
    );
    expect(out).toContain("- `@acme/pdf`");
    expect(out).not.toContain("- `@acme/mine`");
    expect(out.match(/@acme\/mine/g)).toHaveLength(1);
    expect(out).toContain('<skill id="@acme/mine"');
  });

  it("teaches that loading a listed skill pins it, and hands the claim each pin's verdict and the budget left", () => {
    const mine = {
      packageId: "@acme/mine",
      uri: "skill://space-1/acme/mine/mine/SKILL.md",
      version: "1.0.0",
      served: { definition: "published", version: "1.0.0" } as const,
      content: "Mine body.",
    };
    const rendered = identityContext(
      { user: { name: "Ada" }, org: { role: "member" } },
      {
        ...BASE_OPTS,
        skills: { skillDiscovery: true, pinnedSkills: ["@acme/gone", "@acme/mine"] },
        skillContents: new Map([["@acme/mine", mine]]),
        skillCatalogue: [listedSkill("@acme/pdf", "PDF", "1.0.0")],
      },
    );
    expect(rendered.text).toContain(
      "Loading one of these skills (reading its SKILL.md at the URI shown, with `read_resource` or `read`) pins it to the conversation",
    );
    expect(rendered.text.indexOf("pins it to the conversation")).toBeLessThan(
      rendered.text.indexOf("- `@acme/pdf`"),
    );
    expect(rendered.skillStatus).toEqual({ "@acme/gone": "unavailable", "@acme/mine": "injected" });
    expect(rendered.skillBudgetLeft).toBe(64_000 - "Mine body.".length);
  });

  it("lists no pin, even one that did not fit the budget: its notice says why", () => {
    const huge = {
      packageId: "@acme/huge",
      uri: "skill://space-1/acme/huge/huge/SKILL.md",
      version: "1.0.0",
      served: { definition: "published", version: "1.0.0" } as const,
      content: "x".repeat(64_001),
    };
    const out = contextText(
      { user: { name: "Ada" }, org: { role: "member" } },
      {
        ...BASE_OPTS,
        skills: { skillDiscovery: true, pinnedSkills: ["@acme/huge"] },
        skillContents: new Map([["@acme/huge", huge]]),
        skillCatalogue: [listedSkill("@acme/huge", "Huge", "1.0.0")],
      },
    );
    expect(out).not.toContain("- `@acme/huge`");
    expect(out).not.toContain("pins it to the conversation");
    expect(out).toContain("does not fit");
    expect(out).not.toContain('<skill id="@acme/huge"');
  });

  it("lists the turn's skills with discovery on, and none when the turn cannot load one", () => {
    const raw = { user: { name: "Ada" }, org: { role: "member" } };
    const skillCatalogue = [listedSkill("@acme/pdf", "Reads PDFs.", "1.0.0")];
    const PDF_LINE = "- `@acme/pdf` (v1.0.0) `skill://space-1/acme/pdf/pdf/SKILL.md` — Reads PDFs.";
    const out = contextText(raw, { ...BASE_OPTS, skillCatalogue });
    expect(out.split("## Skills")).toHaveLength(2);
    expect(out).toContain(PDF_LINE);
    expect(out).not.toContain("(list truncated)");
    expect(out).not.toContain("<skill");

    // `read_resource` loads one without dispatch; without the transport there is no tool at all.
    const noDispatch = contextText(raw, {
      ...BASE_OPTS,
      capabilities: caps(BUILDER.filter((p) => p !== "mcp:invoke")),
      skillCatalogue,
    });
    expect(noDispatch).toContain(PDF_LINE);
    const noTransport = contextText(raw, {
      ...BASE_OPTS,
      capabilities: caps(BUILDER.filter((p) => p !== "mcp:read")),
      skillCatalogue,
    });
    expect(noTransport).not.toContain("## Skills");
  });

  it("says a pinned skill could not be included", () => {
    const out = contextText(
      { user: { name: "Ada" }, org: { role: "member" } },
      { ...BASE_OPTS, skills: { skillDiscovery: true, pinnedSkills: ["@acme/gone"] } },
    );
    expect(out).toContain("## Skills");
    expect(out).toContain("`@acme/gone` is pinned to this conversation but is not available here");
    expect(out).not.toContain("These skills are pinned to this conversation");
  });

  it("omits the heading entirely when nothing is pinned and nothing is listed", () => {
    for (const capabilities of [caps(BUILDER), caps(WITHOUT_SKILLS)]) {
      const out = contextText(
        { user: { name: "Ada" }, org: { role: "member" } },
        {
          ...BASE_OPTS,
          capabilities,
          skills: { skillDiscovery: true, pinnedSkills: [] },
          skillCatalogue: [],
        },
      );
      expect(out).not.toContain("## Skills");
    }
  });

  it("tells a turn without discovery why it holds no skill permission, even with nothing pinned", () => {
    const off = (pinnedSkills: string[], permissions = BUILDER) =>
      contextText(
        { user: { name: "Ada" }, org: { role: "member" } },
        {
          ...BASE_OPTS,
          capabilities: caps(permissions.filter((p) => !p.startsWith("skills:"))),
          skills: { skillDiscovery: false, pinnedSkills },
          skillCatalogue: [listedSkill("@acme/pdf", "PDF")],
        },
      );
    for (const out of [off([]), off(["@acme/gone"])]) {
      expect(out).toContain("## Skills");
      // The note is about the missing permission; reading the files belongs to the leads.
      expect(out).not.toContain("read_resource");
      expect(out).toContain("Skill discovery is off for this conversation");
      expect(out).toContain("never change a role or a permission to reach one");
      // The two misreadings seen live: an empty listing as "not in the space",
      // and a role change as the way out.
      expect(out).toContain("an empty result says nothing about it");
      expect(out).toContain("turns discovery back on in the skills panel of the composer");
      // No catalogue without discovery.
      expect(out).not.toContain("@acme/pdf");
    }
    const on = contextText(
      { user: { name: "Ada" }, org: { role: "member" } },
      { ...BASE_OPTS, skills: { skillDiscovery: true, pinnedSkills: ["@acme/gone"] } },
    );
    expect(on).not.toContain("Skill discovery is off");
  });

  describe("pinned skills", () => {
    const NO_SKILLS = BUILDER.filter((p) => !p.startsWith("skills:"));
    const mine = (content = "Mine body.") => ({
      packageId: "@acme/mine",
      uri: "skill://space-1/acme/mine/mine/SKILL.md",
      version: "1.0.0",
      served: { definition: "published", version: "1.0.0" } as const,
      content,
    });
    const MINE_BLOCK =
      '<skill id="@acme/mine" uri="skill://space-1/acme/mine/mine/SKILL.md" version="1.0.0">';

    it("orders the discovery note, the pinned skills, then the notices", () => {
      const out = contextText(
        { user: { name: "Ada" } },
        {
          ...BASE_OPTS,
          capabilities: caps(NO_SKILLS),
          skills: { skillDiscovery: false, pinnedSkills: ["@acme/gone", "@acme/mine"] },
          skillContents: new Map([["@acme/mine", mine()]]),
        },
      );
      const at = (text: string) => {
        expect(out).toContain(text);
        return out.indexOf(text);
      };
      expect(at("Skill discovery is off for this conversation")).toBeLessThan(
        at("These skills are pinned to this conversation"),
      );
      expect(at(MINE_BLOCK)).toBeLessThan(at("`@acme/gone` is pinned"));
    });

    it("names `read_resource` on the lead with the transport, with discovery on or off, and none without", () => {
      const render = (skillDiscovery: boolean, permissions: readonly string[]) =>
        contextText(
          { user: { name: "Ada" } },
          {
            ...BASE_OPTS,
            capabilities: caps(permissions),
            skills: { skillDiscovery, pinnedSkills: ["@acme/mine"] },
            skillContents: new Map([["@acme/mine", mine()]]),
          },
        );
      const files =
        "Only each SKILL.md is shown: read a file it references with `read_resource`, replacing `SKILL.md` in the skill's `uri` with the file's path; it serves the version injected here.";
      for (const skillDiscovery of [true, false]) {
        const tool = render(skillDiscovery, NO_SKILLS);
        expect(tool).toContain(`follow it whenever it applies. ${files}`);
        expect(tool).toContain(MINE_BLOCK);
        const none = render(
          skillDiscovery,
          NO_SKILLS.filter((p) => p !== "mcp:read"),
        );
        expect(none).toContain("follow it whenever it applies. Only each SKILL.md is provided.");
        expect(none).not.toContain("read_resource");
      }
    });

    it("renders byte-identical whatever order the skill reads answered in", () => {
      const other = {
        ...mine("Other body."),
        packageId: "@acme/other",
        uri: "skill://space-1/acme/other/other/SKILL.md",
      };
      const render = (contents: [string, ReturnType<typeof mine>][]) =>
        contextText(
          { user: { name: "Ada" } },
          {
            ...BASE_OPTS,
            now: new Date("2026-06-25T09:05:00.000Z"),
            skills: { skillDiscovery: true, pinnedSkills: ["@acme/mine", "@acme/other"] },
            skillContents: new Map(contents),
          },
        );
      const first = render([
        ["@acme/mine", mine()],
        ["@acme/other", other],
      ]);
      expect(first).toContain(MINE_BLOCK);
      expect(first.indexOf(MINE_BLOCK)).toBeLessThan(first.indexOf('id="@acme/other"'));
      expect(
        render([
          ["@acme/other", other],
          ["@acme/mine", mine()],
        ]),
      ).toBe(first);
    });
  });

  it("falls back to email, then a generic label, when the name is missing", () => {
    expect(
      contextText({ user: { email: "ada@acme.com" }, org: { role: "guest" } }, BASE_OPTS),
    ).toContain("assisting ada@acme.com");
    expect(contextText({ org: { role: "guest" } }, BASE_OPTS)).toContain("assisting the user");
  });

  it("omits the role clause when the role is absent", () => {
    const out = contextText({ user: { name: "Ada" } }, BASE_OPTS);
    expect(out).toContain("assisting Ada.");
    expect(out).not.toContain("role in this organization");
  });

  it("renders each skill line with id, version, URI and description, dropping what says nothing", () => {
    const out = contextText(
      { user: { name: "Ada", email: "ada@acme.com" }, org: { role: "member" } },
      {
        ...BASE_OPTS,
        skillCatalogue: [
          listedSkill("@appstrate/web-research", "Multi-source web search.", "1.2.0"),
          listedSkill("@acme/pdf", "Reads PDFs."),
          listedSkill("@acme/bare", " "),
        ],
      },
    );
    expect(out).toContain("## Skills");
    expect(out).toContain(
      "- `@appstrate/web-research` (v1.2.0) `skill://space-1/appstrate/web-research/web-research/SKILL.md` — Multi-source web search.",
    );
    // A draft has no version → no version suffix rendered.
    expect(out).toContain(
      "- `@acme/pdf` `skill://space-1/acme/pdf@draft/pdf/SKILL.md` — Reads PDFs.",
    );
    // A blank description adds nothing.
    expect(out.endsWith("- `@acme/bare` `skill://space-1/acme/bare@draft/bare/SKILL.md`")).toBe(
      true,
    );
    // Data only — the `dependencies.skills` rule lives in `buildSystemPrompt` (when the turn may author).
    expect(out).not.toContain("dependencies.skills");
    expect(out).not.toContain("(list truncated)");
  });

  it("renders a context block from skills alone (no identity)", () => {
    const out = contextText(
      {},
      {
        ...BASE_OPTS,
        skillCatalogue: [listedSkill("@appstrate/web-research", "Research", "1.2.0")],
      },
    );
    expect(out).toContain("## Skills");
    expect(out).toContain("`@appstrate/web-research`");
  });

  it("omits the skills block when there are no installed skills", () => {
    const out = contextText(
      {
        user: { name: "Ada" },
        org: { role: "member" },
      },
      { ...BASE_OPTS, skillCatalogue: [] },
    );
    expect(out).not.toContain("## Skills");
  });

  it("renders org name/slug and grounds date/language from the server (UTC + fr)", () => {
    const out = contextText(
      {
        user: { name: "Ada", email: "ada@acme.com" },
        org: { role: "member", name: "Acme", slug: "acme" },
      },
      BASE_OPTS,
    );
    expect(out).toContain('in the organization "Acme" (`acme`)');
    // No browser clock/timezone is forwarded to this route — always server UTC.
    expect(out).toContain("Current date and time:");
    expect(out).toContain("(UTC, rounded to the hour)");
    expect(out).toContain("Reply in the user's language (fr)");
  });

  it("is byte-identical across a 45-minute gap (the cache invariant)", () => {
    const ctx = {
      user: { name: "Ada", email: "ada@acme.com" },
      org: { role: "member", name: "Acme", slug: "acme" },
    };
    const at = new Date("2026-06-25T09:05:00.000Z");
    const later = new Date("2026-06-25T09:50:00.000Z");
    expect(contextText(ctx, { ...BASE_OPTS, now: later })).toBe(
      contextText(ctx, { ...BASE_OPTS, now: at }),
    );
    // And the rendered hour is the floor, not the raw stamp.
    expect(contextText(ctx, { ...BASE_OPTS, now: at })).toContain("2026-06-25T09:00:00.000Z");
    // No time-of-day precision survives anywhere in the block.
    expect(contextText(ctx, { ...BASE_OPTS, now: at })).not.toMatch(/T\d{2}:(?!00:00\.000Z)/);
    // `opts.now` exists only to make the invariant testable, so the DEFAULT
    // clock has to be floored by the same code — a regression that floored the
    // injected stamp alone would leave everything above green while every real
    // turn re-rendered the block.
    expect(contextText(ctx, BASE_OPTS)).toMatch(
      /Current date and time: \d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z \(UTC, rounded to the hour\)/,
    );
  });
});

/** A skills connection that fails the test if the block opens it. */
const NO_SKILLS = async (): Promise<ChatSkillsClient> => {
  throw new Error("the skills connection was opened");
};

const skillEntry = (uri: string, version: string | null, lockVersion?: number): SkillEntry => ({
  uri,
  frontmatter: { name: "a", description: "A", ...(version ? { metadata: { version } } : {}) },
  resources: [{ uri, digest: `sha256:${"0".repeat(64)}`, size: 1 }],
  ...(lockVersion === undefined ? {} : { _meta: { [SKILL_LOCK_VERSION_META_KEY]: lockVersion } }),
});

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/**
 * A skills connection listing `published` and, under the draft `_meta`,
 * `drafts`, each `SKILL.md` with the digest of its text in `texts`. It serves
 * `texts` by URI, or `savedAfterList` when a URI is there (the skill changed
 * between the list and the read), and `blobs` as base64 (a missing URI is
 * refused). Records each call, whether it was closed, and the signal each
 * hop carried.
 */
function fakeSkillsClient(opts: {
  published: SkillEntry[];
  drafts?: SkillEntry[];
  texts: Record<string, string>;
  savedAfterList?: Record<string, string>;
  blobs?: Record<string, string>;
  listFails?: "published" | "draft";
}) {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const listed = (entries: SkillEntry[]): SkillEntry[] =>
    entries.map((entry) => {
      const text = opts.texts[entry.uri];
      if (text === undefined) return entry;
      return {
        ...entry,
        resources: entry.resources.map((resource) =>
          resource.uri === entry.uri
            ? { ...resource, digest: sha256(text), size: Buffer.byteLength(text) }
            : resource,
        ),
      };
    });
  const client: ChatSkillsClient = {
    listSkills: async (options) => {
      signals.push(options?.signal);
      const draft = options?.meta?.[SKILL_DEFINITION_META_KEY] === "draft";
      calls.push(draft ? "skills/list draft" : "skills/list");
      if ((draft ? "draft" : "published") === opts.listFails) throw new Error("skills/list failed");
      return { skills: listed(draft ? (opts.drafts ?? []) : opts.published) };
    },
    readResource: async ({ uri }, options) => {
      signals.push(options?.signal);
      calls.push(`resources/read ${uri}`);
      const blob = opts.blobs?.[uri];
      if (blob !== undefined) return { contents: [{ uri, mimeType: "text/markdown", blob }] };
      const text = opts.savedAfterList?.[uri] ?? opts.texts[uri];
      if (text === undefined) throw new Error("Resource not found");
      return { contents: [{ uri, mimeType: "text/markdown", text }] };
    },
    close: async () => {
      calls.push("close");
    },
  };
  return {
    open: async (signal: AbortSignal) => {
      signals.push(signal);
      return client;
    },
    calls,
    signals,
  };
}

describe("buildCallerContextBlock", () => {
  const user = { id: "u_1", name: "Ada", email: "ada@acme.com" };

  it("marks the turn's permissions as a role preview while one is on, and only then", async () => {
    const build = (vars: Record<string, unknown>) =>
      blockText(fakeContext(vars), {
        spaces: REACH,
        restricted: false,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read"],
        skills: DEFAULT_SKILL_SELECTION,
        drafts: true,
        openSkillsClient: NO_SKILLS,
      });
    expect(await build({ orgRole: "owner", viewAs: { orgRole: "member" } })).toContain(
      "Permissions this turn (role preview active)",
    );
    expect(await build({ orgRole: "owner" })).not.toContain("role preview");
  });

  it("resolves the pinned skills over the skills connection, draft first", async () => {
    const A = "skill://spc_1/acme/a@draft/a/SKILL.md";
    const B = "skill://spc_1/acme/b@draft/b/SKILL.md";
    const C = "skill://spc_1/acme/c/c/SKILL.md";
    const skills = fakeSkillsClient({
      published: [
        skillEntry("skill://spc_1/acme/a/a/SKILL.md", "1.0.0"),
        skillEntry(C, "2.0.0"),
        // Another space's entry never stands for a skill of this one.
        skillEntry("skill://spc_2/acme/other/other/SKILL.md", "1.0.0"),
      ],
      // `@acme/b`'s draft entry lacks its `lock_version`: malformed.
      drafts: [skillEntry(A, null, 7), skillEntry(B, null)],
      texts: { [A]: "a draft body", [B]: "b draft body", [C]: "c body" },
    });
    const { text: out, injected } = await buildCallerContextBlock(
      fakeContext({ orgRole: "member" }),
      {
        spaces: REACH,
        restricted: false,
        user,
        // Discovery off: the turn holds no `skills:read`, the skills connection still reads.
        capabilities: caps(BUILDER.filter((permission) => permission !== "skills:read")),
        permissions: ["mcp:read", "mcp:invoke"],
        skills: {
          skillDiscovery: false,
          pinnedSkills: ["@acme/a", "@acme/b", "@acme/c", "@acme/off", "@acme/other"],
        },
        drafts: true,
        openSkillsClient: skills.open,
      },
    );
    expect(skills.calls.sort()).toEqual([
      "close",
      `resources/read ${A}`,
      `resources/read ${B}`,
      `resources/read ${C}`,
      "skills/list",
      "skills/list draft",
    ]);
    // The connect and every hop carry the read's one deadline.
    expect(skills.signals).toHaveLength(6);
    expect(skills.signals[0]).toBeInstanceOf(AbortSignal);
    expect(new Set(skills.signals).size).toBe(1);
    // A draft is named as one: it has no version.
    expect(out).toContain(
      `<skill id="@acme/a" uri="${A}" definition="draft">\na draft body\n</skill>`,
    );
    expect(out).toContain(`<skill id="@acme/c" uri="${C}" version="2.0.0">\nc body\n</skill>`);
    expect(out).toContain("`@acme/off` is pinned to this conversation but is not available here");
    expect(out).toContain("`@acme/other` is pinned to this conversation but is not available here");
    // The claim pins the draft to its entry's `lock_version`; a malformed entry is not injected.
    expect(out).not.toContain("b draft body");
    expect(out).toContain("`@acme/b` is pinned to this conversation but could not be read.");
    expect(injected).toEqual({
      skills: {
        "@acme/a": { definition: "draft", lockVersion: 7, spaceId: "spc_1" },
        "@acme/c": { definition: "published", version: "2.0.0", spaceId: "spc_1" },
      },
    });
  });

  it("leaves the pinned skills out, unreadable, when the skills connection cannot open", async () => {
    const out = await blockText(fakeContext({ orgRole: "member" }), {
      spaces: REACH,
      restricted: false,
      user,
      capabilities: caps(BUILDER),
      permissions: ["mcp:read", "mcp:invoke"],
      skills: { skillDiscovery: true, pinnedSkills: ["@acme/a"] },
      drafts: true,
      openSkillsClient: NO_SKILLS,
    });
    expect(out).not.toContain("<skill");
    expect(out).toContain("`@acme/a` is pinned to this conversation but could not be read.");
  });

  it("tells a pin missing from every listing (unavailable) from one whose read failed (unreadable)", async () => {
    const A = "skill://spc_1/acme/a/a/SKILL.md";
    const B = "skill://spc_1/acme/b/b/SKILL.md";
    const D = "skill://spc_1/acme/d@draft/d/SKILL.md";
    const block = (opts: Parameters<typeof fakeSkillsClient>[0]) =>
      buildCallerContextBlock(fakeContext({ orgRole: "member" }), {
        spaces: REACH,
        restricted: false,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read", "mcp:invoke", "skills:read"],
        skills: { skillDiscovery: true, pinnedSkills: ["@acme/a", "@acme/b", "@acme/gone"] },
        drafts: true,
        openSkillsClient: fakeSkillsClient(opts).open,
      });
    // `@acme/b`'s `resources/read` fails; `@acme/gone` is listed nowhere.
    const both = await block({
      published: [skillEntry(A, "1.0.0"), skillEntry(B, "1.0.0")],
      drafts: [skillEntry(D, null, 2)],
      texts: { [A]: "a body", [D]: "d body" },
    });
    expect(both.skillStatus).toEqual({
      "@acme/a": "injected",
      "@acme/b": "unreadable",
      "@acme/gone": "unavailable",
    });
    // What a load must read to pin each listed skill: its draft before its published version.
    expect(both.skillUris).toEqual(
      new Map([
        ["@acme/a", A],
        ["@acme/b", B],
        ["@acme/d", D],
      ]),
    );
    // A failed listing may be the one a pin is missing from: unknown, so unreadable.
    const listFailed = await block({
      published: [skillEntry(A, "1.0.0")],
      texts: { [A]: "a body" },
      listFails: "published",
    });
    expect(listFailed.skillStatus).toEqual({
      "@acme/a": "unreadable",
      "@acme/b": "unreadable",
      "@acme/gone": "unreadable",
    });
    // A failed draft listing hides which pin has a draft: none is injected from its published
    // version in its place.
    const draftsFailed = await block({
      published: [skillEntry(A, "1.0.0"), skillEntry(B, "1.0.0")],
      texts: { [A]: "a body", [B]: "b body" },
      listFails: "draft",
    });
    expect(draftsFailed.skillStatus).toEqual({
      "@acme/a": "unreadable",
      "@acme/b": "unreadable",
      "@acme/gone": "unreadable",
    });
    expect(draftsFailed.injected).toEqual({ skills: {} });
    expect(draftsFailed.text).not.toContain("<skill ");
  });

  it("gives a pinned skill whose SKILL.md is served as a blob its could-not-be-read notice", async () => {
    const A = "skill://spc_1/acme/a/a/SKILL.md";
    const skills = fakeSkillsClient({
      published: [skillEntry(A, "1.0.0")],
      texts: {},
      blobs: { [A]: Buffer.from("a body").toString("base64") },
    });
    const { text: out, injected } = await buildCallerContextBlock(
      fakeContext({ orgRole: "member" }),
      {
        spaces: REACH,
        restricted: false,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read", "mcp:invoke"],
        skills: { skillDiscovery: true, pinnedSkills: ["@acme/a"] },
        drafts: true,
        openSkillsClient: skills.open,
      },
    );
    expect(out).not.toContain("<skill");
    expect(out).toContain("`@acme/a` is pinned to this conversation but could not be read.");
    expect(injected).toEqual({ skills: {} });
  });

  it("gives a pinned skill whose SKILL.md differs from its listed digest its could-not-be-read notice", async () => {
    // The draft is saved between `skills/list` (lock_version 7) and `resources/read`:
    // the text read is the next draft, which the claim's lock_version does not name.
    const A = "skill://spc_1/acme/a@draft/a/SKILL.md";
    const skills = fakeSkillsClient({
      published: [],
      drafts: [skillEntry(A, null, 7)],
      texts: { [A]: "a draft body" },
      savedAfterList: { [A]: "a draft body, saved again" },
    });
    const { text: out, injected } = await buildCallerContextBlock(
      fakeContext({ orgRole: "member" }),
      {
        spaces: REACH,
        restricted: false,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read", "mcp:invoke"],
        skills: { skillDiscovery: true, pinnedSkills: ["@acme/a"] },
        drafts: true,
        openSkillsClient: skills.open,
      },
    );
    // Read once, never retried.
    expect(skills.calls.filter((call) => call.startsWith("resources/read"))).toEqual([
      `resources/read ${A}`,
    ]);
    expect(out).not.toContain("<skill");
    expect(out).not.toContain("saved again");
    expect(out).toContain("`@acme/a` is pinned to this conversation but could not be read.");
    expect(injected).toEqual({ skills: {} });
  });

  it("gives a pinned published skill whose SKILL.md differs from its listed digest its could-not-be-read notice", async () => {
    const A = "skill://spc_1/acme/a/a/SKILL.md";
    const skills = fakeSkillsClient({
      published: [skillEntry(A, "1.0.0")],
      texts: { [A]: "a body" },
      savedAfterList: { [A]: "another body" },
    });
    const { text: out, injected } = await buildCallerContextBlock(
      fakeContext({ orgRole: "member" }),
      {
        spaces: REACH,
        restricted: false,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read", "mcp:invoke"],
        skills: { skillDiscovery: true, pinnedSkills: ["@acme/a"] },
        drafts: true,
        openSkillsClient: skills.open,
      },
    );
    expect(out).not.toContain("another body");
    expect(out).toContain("`@acme/a` is pinned to this conversation but could not be read.");
    expect(injected).toEqual({ skills: {} });
  });

  it("asks for no draft listing on a turn not working on drafts: a pin missing from the published one is unavailable", async () => {
    const A = "skill://spc_1/acme/a/a/SKILL.md";
    const skills = fakeSkillsClient({
      published: [skillEntry(A, "1.0.0")],
      texts: { [A]: "a body" },
      // Would make every missing pin unreadable, were it asked.
      listFails: "draft",
    });
    const block = await buildCallerContextBlock(fakeContext({ orgRole: "member" }), {
      spaces: REACH,
      restricted: false,
      user,
      capabilities: caps(BUILDER),
      permissions: ["mcp:read", "mcp:invoke", "skills:read"],
      skills: { skillDiscovery: true, pinnedSkills: ["@acme/a", "@acme/gone"] },
      drafts: false,
      openSkillsClient: skills.open,
    });
    expect(skills.calls).not.toContain("skills/list draft");
    expect(block.skillStatus).toEqual({ "@acme/a": "injected", "@acme/gone": "unavailable" });
  });

  it("lists, injects and pins one definition per skill: the draft only on a turn that works on drafts", async () => {
    const A = "skill://spc_1/acme/a/a/SKILL.md";
    const A_DRAFT = "skill://spc_1/acme/a@draft/a/SKILL.md";
    const B = "skill://spc_1/acme/b/b/SKILL.md";
    const B_DRAFT = "skill://spc_1/acme/b@draft/b/SKILL.md";
    const build = (drafts: boolean) =>
      buildCallerContextBlock(fakeContext({ orgRole: "member" }), {
        spaces: REACH,
        restricted: false,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read", "mcp:invoke", "skills:read", ...(drafts ? ["skills:write"] : [])],
        skills: { skillDiscovery: true, pinnedSkills: ["@acme/a"] },
        drafts,
        openSkillsClient: fakeSkillsClient({
          published: [skillEntry(A, "1.0.0"), skillEntry(B, "1.0.0")],
          drafts: [skillEntry(A_DRAFT, null, 3), skillEntry(B_DRAFT, null, 4)],
          texts: { [A]: "a published", [A_DRAFT]: "a draft" },
        }).open,
      });
    // Authoring off: the published version everywhere, so a load of the listed URI pins the
    // definition later turns inject.
    const published = await build(false);
    expect(published.text).toContain("a published");
    expect(published.text).not.toContain("a draft");
    expect(published.text).toContain(`- \`@acme/b\` (v1.0.0) \`${B}\``);
    expect(published.skillUris).toEqual(
      new Map([
        ["@acme/a", A],
        ["@acme/b", B],
      ]),
    );
    // Working on drafts: the draft everywhere.
    const drafted = await build(true);
    expect(drafted.text).toContain("a draft");
    expect(drafted.text).toContain(`- \`@acme/b\` \`${B_DRAFT}\``);
    expect(drafted.skillUris).toEqual(
      new Map([
        ["@acme/a", A_DRAFT],
        ["@acme/b", B_DRAFT],
      ]),
    );
  });

  it("lists the turn's skills over the skills connection, draft first, reading none when nothing is pinned", async () => {
    const skills = fakeSkillsClient({
      published: [
        skillEntry("skill://spc_1/acme/a/a/SKILL.md", "1.0.0"),
        skillEntry("skill://spc_1/acme/c/c/SKILL.md", "2.0.0"),
        // Another space's entry is not this space's skill.
        skillEntry("skill://spc_2/acme/other/other/SKILL.md", "1.0.0"),
      ],
      drafts: [skillEntry("skill://spc_1/acme/a@draft/a/SKILL.md", null, 7)],
      texts: {},
    });
    const { text: out, injected } = await buildCallerContextBlock(
      fakeContext({ orgRole: "member" }),
      {
        spaces: REACH,
        restricted: false,
        user,
        capabilities: caps(BUILDER),
        // The turn keeps `skills:write`: it reads the drafts the caller reads.
        permissions: ["mcp:read", "mcp:invoke", "skills:read", "skills:write"],
        skills: { skillDiscovery: true, pinnedSkills: [] },
        drafts: true,
        openSkillsClient: skills.open,
      },
    );
    expect(skills.calls.sort()).toEqual(["close", "skills/list", "skills/list draft"]);
    expect(out).toContain(
      "- `@acme/a` `skill://spc_1/acme/a@draft/a/SKILL.md` — A\n- `@acme/c` (v2.0.0) `skill://spc_1/acme/c/c/SKILL.md` — A",
    );
    expect(out).not.toContain("@acme/other");
    expect(out).not.toContain("<skill");
    expect(injected).toEqual({ skills: {} });

    // Without `skills:write` (authoring off), the turn's `read_resource` refuses a
    // draft URI: the catalogue lists the published entry, and no unpublished draft.
    const readOnly = fakeSkillsClient({
      published: [skillEntry("skill://spc_1/acme/a/a/SKILL.md", "1.0.0")],
      drafts: [
        skillEntry("skill://spc_1/acme/a@draft/a/SKILL.md", null, 7),
        skillEntry("skill://spc_1/acme/new@draft/new/SKILL.md", null, 1),
      ],
      texts: {},
    });
    const readOnlyOut = await blockText(fakeContext({ orgRole: "member" }), {
      spaces: REACH,
      restricted: false,
      user,
      capabilities: caps(BUILDER),
      permissions: ["mcp:read", "mcp:invoke", "skills:read"],
      skills: { skillDiscovery: true, pinnedSkills: [] },
      drafts: false,
      openSkillsClient: readOnly.open,
    });
    expect(readOnlyOut).toContain("- `@acme/a` (v1.0.0) `skill://spc_1/acme/a/a/SKILL.md` — A");
    expect(readOnlyOut).not.toContain("@draft");
    expect(readOnlyOut).not.toContain("@acme/new");

    // A turn that cannot load a skill lists none, and opens nothing.
    let opened = false;
    await blockText(fakeContext({ orgRole: "member" }), {
      spaces: REACH,
      restricted: false,
      user,
      capabilities: caps(BUILDER.filter((permission) => permission !== "skills:read")),
      permissions: ["mcp:read", "mcp:invoke"],
      skills: { skillDiscovery: true, pinnedSkills: [] },
      drafts: true,
      openSkillsClient: async (signal) => {
        opened = true;
        return skills.open(signal);
      },
    });
    expect(opened).toBe(false);
  });

  it("reads the pinned skills and lists the others in the same turn, the pinned one in the catalogue never", async () => {
    const A = "skill://spc_1/acme/a/a/SKILL.md";
    const C = "skill://spc_1/acme/c/c/SKILL.md";
    const skills = fakeSkillsClient({
      published: [skillEntry(A, "1.0.0"), skillEntry(C, "2.0.0")],
      texts: { [A]: "a body" },
    });
    const { text: out, injected } = await buildCallerContextBlock(
      fakeContext({ orgRole: "member" }),
      {
        spaces: REACH,
        restricted: false,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read", "mcp:invoke", "skills:read"],
        skills: { skillDiscovery: true, pinnedSkills: ["@acme/a"] },
        drafts: true,
        openSkillsClient: skills.open,
      },
    );
    expect(skills.calls.sort()).toEqual([
      "close",
      `resources/read ${A}`,
      "skills/list",
      "skills/list draft",
    ]);
    expect(out).toContain(`<skill id="@acme/a" uri="${A}" version="1.0.0">\na body\n</skill>`);
    expect(out).toContain(`- \`@acme/c\` (v2.0.0) \`${C}\``);
    expect(out).not.toContain("- `@acme/a`");
    expect(injected).toEqual({
      skills: { "@acme/a": { definition: "published", version: "1.0.0", spaceId: "spc_1" } },
    });
  });

  it("leaves out, unreadable, a pinned skill whose content read is refused", async () => {
    const skills = fakeSkillsClient({
      published: [skillEntry("skill://spc_1/acme/a/a/SKILL.md", "1.0.0")],
      texts: {},
    });
    const out = await blockText(fakeContext({ orgRole: "member" }), {
      spaces: REACH,
      restricted: false,
      user,
      capabilities: caps(BUILDER),
      permissions: ["mcp:read", "mcp:invoke"],
      skills: { skillDiscovery: true, pinnedSkills: ["@acme/a"] },
      drafts: true,
      openSkillsClient: skills.open,
    });
    expect(out).not.toContain("<skill");
    expect(out).toContain("`@acme/a` is pinned to this conversation but could not be read.");
    expect(skills.calls).toContain("close");
  });
});
