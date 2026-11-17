// SPDX-License-Identifier: Apache-2.0

/**
 * The chat injects a "## Your context" block into the system prompt so the agent knows who it
 * is acting for, their role, the spaces the conversation can act in (its origin space being the
 * default of a request naming none) and the skills it follows. `formatCallerContext` renders that block from the
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
import type { EnforcedChatSkill } from "@appstrate/core/chat-contract";
import {
  SKILL_DEFINITION_META_KEY,
  SKILL_LOCK_VERSION_META_KEY,
  type SkillEntry,
} from "@appstrate/core/skill-uri";

/** The rendered texts; the injected-skills claim has its own cases. */
const contextText = (...args: Parameters<typeof identityContext>) => identityContext(...args).text;

/** `formatCallerContext` over an identity given loosely: what is not named is not known. */
function identityContext(
  raw: { user?: { name?: string; email?: string }; org?: Record<string, string> },
  opts: Omit<Parameters<typeof formatCallerContext>[1], "spaces"> &
    Partial<Pick<Parameters<typeof formatCallerContext>[1], "spaces">>,
) {
  return formatCallerContext(
    {
      user: { name: raw.user?.name ?? null, email: raw.user?.email ?? null },
      org: {
        role: raw.org?.role ?? null,
        name: raw.org?.name ?? null,
        slug: raw.org?.slug ?? null,
      },
    },
    { spaces: [], ...opts },
  );
}
const blockText = async (...args: Parameters<typeof buildCallerContextBlock>) =>
  (await buildCallerContextBlock(...args)).text;

/** Minimal Hono-context stub exposing the `c.get(key)` reads the builder makes. */

function fakeContext(vars: Record<string, unknown>): any {
  return { get: (k: string) => vars[k] };
}

/** The turn's capabilities, from the permission set a role actually grants. */
function caps(permissions: readonly string[]) {
  return turnCapabilities((permission) => permissions.includes(permission));
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
  {
    id: "spc_1",
    name: "One",
    role: "builder",
    permissions: ["chat:read", "chat:write", ...BUILDER],
    credentialProxyOpen: true,
  },
];

/**
 * Opts every case shares; a case that is ABOUT one of them overrides it. The
 * permission-shaped fields are required, so a literal per call would be noise
 * the reader has to diff.
 */
const BASE_OPTS = {
  capabilities: caps(BUILDER),
  rolePreview: false,
  spaces: REACH,
  restricted: false,
  originLapsed: false,
  permissions: ["agents:read", "mcp:invoke"],
  skills: DEFAULT_SKILL_SELECTION,
  enforced: [],
} as const;

/** The origin space, which owns the enforced skills. */
const ORIGIN = { id: "spc_1", name: "One" };

/** A line of the `auto` catalogue: the published entry of `@<scope>/<name>`, or its draft. */
const listedSkill = (packageId: string, description: string, version: string | null = null) => {
  const [scope, name] = packageId.slice(1).split("/");
  return {
    packageId,
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

  it("injects the chosen skills in full, in stored order, tagged with id and version, in manual and strict", () => {
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
    // Strict turns hold no `skills:read`: the injected skills need no tool.
    for (const [skillMode, permissions] of [
      ["manual", BUILDER],
      ["strict", BUILDER.filter((p) => p !== "skills:read")],
    ] as const) {
      const out = contextText(raw, {
        ...BASE_OPTS,
        capabilities: caps(permissions),
        skills: { skillMode, pinnedSkills: ["@acme/mine", "@acme/zeta"] },
        skillContents,
        skillCatalogue,
      });
      expect(out.split("## Skills")).toHaveLength(2);
      expect(out).toContain("The user chose these skills for this conversation.");
      expect(out).toContain(
        '<skill id="@acme/mine" uri="skill://space-1/acme/mine/mine/SKILL.md" version="1.0.0">\nMine body.\n</skill>',
      );
      expect(out).toContain(
        '<skill id="@acme/zeta" uri="skill://space-1/acme/zeta/zeta/SKILL.md" version="1.0.0">\n---\nname: zeta\n---\nZeta body.\n</skill>',
      );
      expect(out.indexOf("@acme/mine")).toBeLessThan(out.indexOf("@acme/zeta"));
      // No listing next to the chosen skills.
      expect(out).not.toContain("@acme/pdf");
    }
  });

  it("lists the turn's skills in auto, and none when the turn cannot load one", () => {
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

  it("says a chosen skill could not be included", () => {
    const out = contextText(
      { user: { name: "Ada" }, org: { role: "member" } },
      { ...BASE_OPTS, skills: { skillMode: "manual", pinnedSkills: ["@acme/gone"] } },
    );
    expect(out).toContain("## Skills");
    expect(out).toContain(
      "`@acme/gone` was chosen for this conversation but is not available here",
    );
    expect(out).not.toContain("The user chose these skills");
  });

  it("omits the heading entirely when nothing is chosen and nothing is listed", () => {
    // `manual` always renders its `list_skills` rule to a turn holding `skills:read`.
    for (const capabilities of [caps(BUILDER), caps(WITHOUT_SKILLS)]) {
      const out = contextText(
        { user: { name: "Ada" }, org: { role: "member" } },
        {
          ...BASE_OPTS,
          capabilities,
          skills: { skillMode: "auto", pinnedSkills: [] },
          skillCatalogue: [],
        },
      );
      expect(out).not.toContain("## Skills");
    }
    const manual = contextText(
      { user: { name: "Ada" }, org: { role: "member" } },
      {
        ...BASE_OPTS,
        capabilities: caps(WITHOUT_SKILLS),
        skills: { skillMode: "manual", pinnedSkills: [] },
      },
    );
    expect(manual).not.toContain("## Skills");
  });

  it("teaches a manual turn holding `skills:read` to list a skill it does not see, and no other turn", () => {
    const rule =
      "When the user asks for a skill not shown here, call `list_skills`, then load the one asked for with `read_resource` on its `uri`.";
    const render = (skillMode: "auto" | "manual" | "strict", permissions: readonly string[]) =>
      contextText(
        { user: { name: "Ada" }, org: { role: "member" } },
        { ...BASE_OPTS, capabilities: caps(permissions), skills: { skillMode, pinnedSkills: [] } },
      );
    expect(render("manual", BUILDER)).toContain(`## Skills\n\n${rule}`);
    // `auto` lists the whole catalogue in the context; `strict` and a turn
    // without `skills:read` hold no `list_skills`.
    expect(render("auto", BUILDER)).not.toContain("list_skills");
    expect(render("strict", WITHOUT_SKILLS)).not.toContain("list_skills");
    expect(render("manual", WITHOUT_SKILLS)).not.toContain("list_skills");
  });

  it("tells a strict turn why it holds no skill permission, even with nothing chosen", () => {
    const strict = (pinnedSkills: string[], permissions = BUILDER) =>
      contextText(
        { user: { name: "Ada" }, org: { role: "member" } },
        {
          ...BASE_OPTS,
          capabilities: caps(permissions.filter((p) => !p.startsWith("skills:"))),
          skills: { skillMode: "strict", pinnedSkills },
        },
      );
    for (const out of [strict([]), strict(["@acme/gone"])]) {
      expect(out).toContain("## Skills");
      // The note is about the restriction; reading the files belongs to the leads.
      expect(out).not.toContain("read_resource");
      expect(out).toContain("This conversation is restricted to the skills shown here");
      expect(out).toContain("never change a role or a permission to reach one");
      // The two misreadings seen live: an empty listing as "not in the space",
      // and a role change as the way out.
      expect(out).toContain("an empty result says nothing about it");
      expect(out).toContain("switching this conversation's skill mode in the composer");
    }
    const manual = contextText(
      { user: { name: "Ada" }, org: { role: "member" } },
      { ...BASE_OPTS, skills: { skillMode: "manual", pinnedSkills: ["@acme/gone"] } },
    );
    expect(manual).not.toContain("This conversation is restricted");
  });

  describe("space-enforced skills", () => {
    const HOUSE: EnforcedChatSkill = {
      packageId: "@acme/house",
      name: "House rules",
      version: "2.0.0",
      uri: "skill://space-1/acme/house/house/SKILL.md",
      content: "---\nname: house\n---\nHouse body.",
    };
    const HOUSE_BLOCK =
      '<skill id="@acme/house" uri="skill://space-1/acme/house/house/SKILL.md" version="2.0.0">\n---\nname: house\n---\nHouse body.\n</skill>';
    const ENFORCED_LEAD =
      "This space — One (`spc_1`), where this conversation was started — requires these skills in every conversation.";
    const NO_SKILLS = BUILDER.filter((p) => !p.startsWith("skills:"));

    it("renders them in every mode, for a turn that cannot read skills", () => {
      for (const skillMode of ["auto", "manual", "strict"] as const) {
        const out = contextText(
          { user: { name: "Ada" }, org: { role: "member" } },
          {
            ...BASE_OPTS,
            origin: ORIGIN,
            capabilities: caps(NO_SKILLS),
            skills: { skillMode, pinnedSkills: [] },
            enforced: [HOUSE],
          },
        );
        expect(out.split("## Skills")).toHaveLength(2);
        expect(out).toContain(ENFORCED_LEAD);
        expect(out).toContain("where it conflicts with a skill the user chose, it wins");
        expect(out).toContain(
          "read a file it references with `read_resource`, replacing `SKILL.md` in the skill's `uri` with the file's path; it serves the version injected here.",
        );
        expect(out).not.toContain("out of reach unless");
        expect(out).toContain(HOUSE_BLOCK);
      }
    });

    it("names `read_resource` only to a turn that holds the MCP transport", () => {
      const lead = (permissions: readonly string[]) =>
        contextText(
          { user: { name: "Ada" } },
          { ...BASE_OPTS, origin: ORIGIN, capabilities: caps(permissions), enforced: [HOUSE] },
        );
      const noTransport = lead(NO_SKILLS.filter((p) => p !== "mcp:read"));
      expect(noTransport).toContain(`${ENFORCED_LEAD} Each is a procedure`);
      expect(noTransport).toContain("it wins. Only each SKILL.md is provided.\n");
      expect(noTransport).not.toContain("read_resource");
      expect(noTransport).toContain(HOUSE_BLOCK);
      // Control: the same turn with the transport is told the tool.
      expect(lead(NO_SKILLS)).toContain("read a file it references with `read_resource`");
    });

    it("leaves the injected ones out of the `auto` listing", () => {
      const out = contextText(
        { user: { name: "Ada" } },
        {
          ...BASE_OPTS,
          origin: ORIGIN,
          enforced: [HOUSE],
          skillCatalogue: [
            listedSkill("@acme/house", "House rules"),
            listedSkill("@acme/pdf", "PDF"),
          ],
        },
      );
      expect(out).toContain("- `@acme/pdf` `skill://space-1/acme/pdf@draft/pdf/SKILL.md` — PDF");
      expect(out).not.toContain("- `@acme/house`");
      expect(out.split("@acme/house")).toHaveLength(2);

      // One the turn could not inject stays listed, so the model can still load it.
      const unpublished = contextText(
        { user: { name: "Ada" } },
        {
          ...BASE_OPTS,
          origin: ORIGIN,
          enforced: [{ ...HOUSE, version: null, uri: null, content: null }],
          skillCatalogue: [listedSkill("@acme/house", "House rules")],
        },
      );
      expect(unpublished).toContain(
        "- `@acme/house` `skill://space-1/acme/house@draft/house/SKILL.md` — House rules",
      );
    });

    it("orders the strict note, the space's skills, the chosen ones, then the notices", () => {
      const out = contextText(
        { user: { name: "Ada" } },
        {
          ...BASE_OPTS,
          origin: ORIGIN,
          capabilities: caps(NO_SKILLS),
          skills: {
            skillMode: "strict",
            pinnedSkills: ["@acme/gone", "@acme/house", "@acme/mine"],
          },
          skillContents: new Map([
            [
              "@acme/mine",
              {
                packageId: "@acme/mine",
                uri: "skill://space-1/acme/mine/mine/SKILL.md",
                version: "1.0.0",
                served: { definition: "published", version: "1.0.0" },
                content: "Mine body.",
              },
            ],
            [
              "@acme/house",
              {
                packageId: "@acme/house",
                uri: "skill://space-1/acme/house/house/SKILL.md",
                version: "1.0.0",
                served: { definition: "published", version: "1.0.0" },
                content: "Pinned copy.",
              },
            ],
          ]),
          enforced: [HOUSE],
        },
      );
      const at = (text: string) => {
        expect(out).toContain(text);
        return out.indexOf(text);
      };
      expect(at("This conversation is restricted to the skills shown here")).toBeLessThan(
        at(ENFORCED_LEAD),
      );
      expect(at(ENFORCED_LEAD)).toBeLessThan(at("The user chose these skills"));
      expect(
        at('<skill id="@acme/mine" uri="skill://space-1/acme/mine/mine/SKILL.md" version="1.0.0">'),
      ).toBeLessThan(at("`@acme/gone` was chosen"));
      // A pin naming an enforced skill is dropped: one copy, the space's.
      expect(out).not.toContain("Pinned copy.");
      expect(out).not.toContain("`@acme/house` was chosen");
    });

    it("names `read_resource` on both leads with the transport, in manual and strict, and none without", () => {
      const render = (skillMode: "manual" | "strict", permissions: readonly string[]) =>
        contextText(
          { user: { name: "Ada" } },
          {
            ...BASE_OPTS,
            origin: ORIGIN,
            capabilities: caps(permissions),
            skills: { skillMode, pinnedSkills: ["@acme/mine"] },
            skillContents: new Map([
              [
                "@acme/mine",
                {
                  packageId: "@acme/mine",
                  uri: "skill://space-1/acme/mine/mine/SKILL.md",
                  version: "1.0.0",
                  served: { definition: "published", version: "1.0.0" },
                  content: "Mine body.",
                },
              ],
            ]),
            enforced: [HOUSE],
          },
        );
      const files =
        "Only each SKILL.md is shown: read a file it references with `read_resource`, replacing `SKILL.md` in the skill's `uri` with the file's path; it serves the version injected here.";
      for (const skillMode of ["manual", "strict"] as const) {
        const tool = render(skillMode, NO_SKILLS);
        expect(tool).toContain(`it wins. ${files}`);
        expect(tool).toContain(`follow it whenever it applies. ${files}`);
        expect(tool).toContain(
          '<skill id="@acme/mine" uri="skill://space-1/acme/mine/mine/SKILL.md" version="1.0.0">',
        );
        const none = render(
          skillMode,
          NO_SKILLS.filter((p) => p !== "mcp:read"),
        );
        expect(none).toContain("follow it whenever it applies. Only each SKILL.md is provided.");
        expect(none).not.toContain("read_resource");
      }
    });

    it("keeps strict's note true: the space's requirement stays whatever the composer says", () => {
      const out = contextText(
        { user: { name: "Ada" } },
        {
          ...BASE_OPTS,
          origin: ORIGIN,
          capabilities: caps(NO_SKILLS),
          skills: { skillMode: "strict", pinnedSkills: [] },
          enforced: [HOUSE],
        },
      );
      expect(out).toContain(
        "those this conversation's origin space requires and those the user chose",
      );
      expect(out).toContain("The user lifts only their own restriction");
      expect(out).toContain("their requirement stays");
    });

    it("notices an enforced skill with no readable version", () => {
      const out = contextText(
        { user: { name: "Ada" } },
        { ...BASE_OPTS, origin: ORIGIN, enforced: [{ ...HOUSE, version: null, content: null }] },
      );
      expect(out).toContain(
        "`@acme/house` is required by this conversation's origin space but has no published version to follow.",
      );
      expect(out).not.toContain(ENFORCED_LEAD);
    });

    it("renders byte-identical across two turns", () => {
      const other: EnforcedChatSkill = { ...HOUSE, packageId: "@acme/alpha", content: "Alpha." };
      const render = () =>
        contextText(
          { user: { name: "Ada" } },
          {
            ...BASE_OPTS,
            origin: ORIGIN,
            now: new Date("2026-06-25T09:05:00.000Z"),
            enforced: [other, HOUSE],
            skillCatalogue: [listedSkill("@acme/pdf", "PDF")],
          },
        );
      const first = render();
      expect(render()).toBe(first);
      expect(first.indexOf("@acme/alpha")).toBeLessThan(first.indexOf("@acme/house"));
    });
  });

  it("falls back to email, then a generic label, when the name is missing", () => {
    expect(
      contextText({ user: { email: "ada@acme.com" }, org: { role: "guest" } }, BASE_OPTS),
    ).toContain("assisting ada@acme.com");
    expect(contextText({ org: { role: "guest" } }, BASE_OPTS)).toContain("assisting the user");
  });

  it("omits the role clause when the role is absent", () => {
    const out = contextText({ user: { name: "Ada" }, connections: [] }, BASE_OPTS);
    expect(out).toContain("assisting Ada.");
    expect(out).not.toContain("role in this organization");
  });

  it("renders each skill line with id, version, URI and description, dropping what says nothing", () => {
    const out = contextText(
      { user: { name: "Ada", email: "ada@acme.com" }, org: { role: "member" }, connections: [] },
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

  it("renders a context block from skills alone (no identity/connections/agents)", () => {
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
        connections: [],
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
        connections: [],
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
      connections: [{ integration_package_id: "@appstrate/gmail", name: "Gmail", source: "own" }],
      agents: [{ packageId: "@appstrate/triage", takes_input: false }],
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

/** The space enforces nothing: the turn's load resolved empty. */
const NO_ENFORCED: Promise<readonly EnforcedChatSkill[]> = Promise.resolve([]);

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

  describe("the origin space", () => {
    const build = (extra: {
      origin?: typeof ORIGIN;
      restricted?: boolean;
      originLapsed?: boolean;
    }) =>
      blockText(fakeContext({ orgRole: "member" }), {
        spaces: REACH,
        restricted: false,
        originLapsed: false,
        ...extra,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read", "mcp:invoke"],
        skills: DEFAULT_SKILL_SELECTION,
        enforced: NO_ENFORCED,
        openSkillsClient: NO_SKILLS,
      });

    it("lists the acting spaces and names the origin space as the default", async () => {
      const out = await build({ origin: ORIGIN });
      expect(out).toContain("- `spc_1` — One (role builder)");
      expect(out).toContain(
        "This conversation was started in One (`spc_1`): when the user names no space, pass `spc_1` as the `space_id`; never move a refused action into another space.",
      );
    });

    it("tells the model an origin space's required skills lapse once its author cannot act there", async () => {
      const out = await build({ originLapsed: true });
      expect(out).toContain("## Skills");
      expect(out).toContain(
        "requires skills in every conversation, but you can no longer act in it: those skills do not apply to this turn.",
      );
      // An origin the author still acts in, or none at all, says nothing of the sort.
      expect(await build({ origin: ORIGIN })).not.toContain("no longer act in it");
      expect(await build({})).not.toContain("no longer act in it");
    });

    it("names no default without an origin space (the overview)", async () => {
      const out = await build({});
      expect(out).not.toContain("This conversation was started in");
      expect(out).toContain("Ask the user which space when the request does not say");
    });

    it("says a limited conversation acts in its origin space alone, naming it on every call", async () => {
      const out = await build({ origin: ORIGIN, restricted: true });
      expect(out).toContain(
        "This conversation is limited to One (`spc_1`): pass `spc_1` as the `space_id` of every call; no other space can be reached.",
      );
      expect(out).toContain("The user lifts the limit in the composer");
      expect(out).not.toContain("Ask the user which space");
      expect(out).not.toContain("This conversation was started in");
    });
  });

  it("resolves the chosen skills over the skills connection, draft first", async () => {
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
        originLapsed: false,
        user,
        // Strict: the turn holds no `skills:read`, the skills connection still reads.
        capabilities: caps(BUILDER.filter((permission) => permission !== "skills:read")),
        permissions: ["mcp:read", "mcp:invoke"],
        skills: {
          skillMode: "strict",
          pinnedSkills: ["@acme/a", "@acme/b", "@acme/c", "@acme/off", "@acme/other"],
        },
        enforced: NO_ENFORCED,
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
    expect(out).toContain("`@acme/off` was chosen for this conversation but is not available here");
    expect(out).toContain(
      "`@acme/other` was chosen for this conversation but is not available here",
    );
    // The claim pins the draft to its entry's `lock_version`; a malformed entry is not injected.
    expect(out).not.toContain("b draft body");
    expect(out).toContain("`@acme/b` was chosen for this conversation but could not be read.");
    expect(injected).toEqual({
      skills: {
        "@acme/a": { definition: "draft", lockVersion: 7, spaceId: "spc_1" },
        "@acme/c": { definition: "published", version: "2.0.0", spaceId: "spc_1" },
      },
    });
  });

  it("leaves the chosen skills out when the skills connection cannot open", async () => {
    const out = await blockText(fakeContext({ orgRole: "member" }), {
      spaces: REACH,
      restricted: false,
      user,
      capabilities: caps(BUILDER),
      permissions: ["mcp:read", "mcp:invoke"],
      skills: { skillMode: "manual", pinnedSkills: ["@acme/a"] },
      enforced: NO_ENFORCED,
      openSkillsClient: NO_SKILLS,
    });
    expect(out).not.toContain("<skill");
    expect(out).toContain("`@acme/a` was chosen for this conversation but is not available here");
  });

  it("gives a chosen skill whose SKILL.md is served as a blob its could-not-be-read notice", async () => {
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
        originLapsed: false,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read", "mcp:invoke"],
        skills: { skillMode: "manual", pinnedSkills: ["@acme/a"] },
        enforced: NO_ENFORCED,
        openSkillsClient: skills.open,
      },
    );
    expect(out).not.toContain("<skill");
    expect(out).toContain("`@acme/a` was chosen for this conversation but could not be read.");
    expect(injected).toEqual({ skills: {} });
  });

  it("gives a chosen skill whose SKILL.md differs from its listed digest its could-not-be-read notice", async () => {
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
        originLapsed: false,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read", "mcp:invoke"],
        skills: { skillMode: "manual", pinnedSkills: ["@acme/a"] },
        enforced: NO_ENFORCED,
        openSkillsClient: skills.open,
      },
    );
    // Read once, never retried.
    expect(skills.calls.filter((call) => call.startsWith("resources/read"))).toEqual([
      `resources/read ${A}`,
    ]);
    expect(out).not.toContain("<skill");
    expect(out).not.toContain("saved again");
    expect(out).toContain("`@acme/a` was chosen for this conversation but could not be read.");
    expect(injected).toEqual({ skills: {} });
  });

  it("gives a chosen published skill whose SKILL.md differs from its listed digest its could-not-be-read notice", async () => {
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
        originLapsed: false,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read", "mcp:invoke"],
        skills: { skillMode: "manual", pinnedSkills: ["@acme/a"] },
        enforced: NO_ENFORCED,
        openSkillsClient: skills.open,
      },
    );
    expect(out).not.toContain("another body");
    expect(out).toContain("`@acme/a` was chosen for this conversation but could not be read.");
    expect(injected).toEqual({ skills: {} });
  });

  it("lists the turn's skills in auto over the skills connection, draft first, reading none", async () => {
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
        originLapsed: false,
        user,
        capabilities: caps(BUILDER),
        // The turn keeps `skills:write`: it reads the drafts the caller reads.
        permissions: ["mcp:read", "mcp:invoke", "skills:read", "skills:write"],
        skills: { skillMode: "auto", pinnedSkills: ["@acme/a"] },
        enforced: NO_ENFORCED,
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
      skills: { skillMode: "auto", pinnedSkills: [] },
      enforced: NO_ENFORCED,
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
      skills: { skillMode: "auto", pinnedSkills: ["@acme/a"] },
      enforced: NO_ENFORCED,
      openSkillsClient: async (signal) => {
        opened = true;
        return skills.open(signal);
      },
    });
    expect(opened).toBe(false);
  });

  it("leaves out a chosen skill whose content read is refused", async () => {
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
      skills: { skillMode: "manual", pinnedSkills: ["@acme/a"] },
      enforced: NO_ENFORCED,
      openSkillsClient: skills.open,
    });
    expect(out).not.toContain("<skill");
    expect(out).toContain("`@acme/a` was chosen for this conversation but is not available here");
    expect(skills.calls).toContain("close");
  });

  describe("space-enforced skills", () => {
    const HOUSE: EnforcedChatSkill = {
      packageId: "@acme/house",
      name: "House rules",
      version: "2.0.0",
      uri: "skill://space-1/acme/house/house/SKILL.md",
      content: "House body.",
    };
    const HOUSE_BLOCK =
      '<skill id="@acme/house" uri="skill://space-1/acme/house/house/SKILL.md" version="2.0.0">\nHouse body.\n</skill>';
    const build = (enforced: Promise<readonly EnforcedChatSkill[]>) =>
      blockText(fakeContext({ orgRole: "member" }), {
        spaces: REACH,
        restricted: false,
        origin: ORIGIN,
        user,
        capabilities: caps(BUILDER),
        permissions: ["mcp:read", "mcp:invoke"],
        skills: DEFAULT_SKILL_SELECTION,
        enforced,
        openSkillsClient: NO_SKILLS,
      });

    it("renders them in the block, after the identity", async () => {
      const out = await build(Promise.resolve([HOUSE]));
      expect(out).toContain("## Your context");
      expect(out).toContain("Ada (ada@acme.com)");
      expect(out).toContain(HOUSE_BLOCK);
    });

    it("rejects when they cannot be loaded, rather than render without them", async () => {
      const failure = new Error("enforced skills unavailable");
      await expect(build(Promise.reject(failure))).rejects.toBe(failure);
    });
  });
});
