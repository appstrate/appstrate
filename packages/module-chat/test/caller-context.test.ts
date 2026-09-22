// SPDX-License-Identifier: Apache-2.0

/**
 * The chat fetches GET /api/me/context (the `get_me` payload) and injects a
 * "## Your context" block into the system prompt so the agent knows who it is
 * acting for, their role, and which integrations are already connected.
 * `formatCallerContext` renders that block from the raw payload and returns ""
 * when there is nothing useful to inject (so the caller skips it).
 */

import { describe, expect, it } from "bun:test";
import { formatCallerContext, buildCallerContextBlock } from "../src/prompt.ts";
import { turnCapabilities } from "../src/capabilities.ts";
import { DEFAULT_SKILL_SELECTION, PLATFORM_DEFAULT_SKILLS } from "../src/skills.ts";
import type { ChatPlatformDeps } from "../src/platform-services.ts";

/** Minimal Hono-context stub exposing the `c.get(key)` reads the builder makes. */

function fakeContext(vars: Record<string, unknown>): any {
  return { get: (k: string) => vars[k] };
}

/** The one `Role in this space:` line, so an assertion cannot match elsewhere in the block. */
function roleLine(block: string): string | undefined {
  return block.split("\n").find((line) => line.startsWith("Role in this space:"));
}

/** Deps whose dispatch returns a scripted Response and records the request. */
function fakeDeps(respond: (req: Request) => Response): {
  deps: ChatPlatformDeps;
  lastRequest: () => Request | null;
} {
  let last: Request | null = null;
  return {
    deps: {
      dispatch: async (req) => {
        last = req;
        return respond(req);
      },
      rateLimit: () => async (_c, next) => next(),
      resolveChatModel: async () => ({ subscription: false }),
      recordChatUsage: async () => {},
      checkUsageAllowed: async () => null,
    },
    lastRequest: () => last,
  };
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
/** The same caller with the authoring toggle off (or a persona without it). */
const NO_AUTHORING = BUILDER.filter((permission) => permission !== "agents:write");

/**
 * Opts every case shares; a case that is ABOUT one of them overrides it. The
 * permission-shaped fields are required, so a literal per call would be noise
 * the reader has to diff.
 */
const BASE_OPTS = {
  capabilities: caps(BUILDER),
  rolePreview: false,
  spaceRole: "builder",
  permissions: ["agents:read", "mcp:invoke"],
  skills: DEFAULT_SKILL_SELECTION,
} as const;

describe("formatCallerContext", () => {
  it("renders identity, role, and connected integrations with their default tools", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada Lovelace", email: "ada@acme.com" },
        org: { role: "member" },
        connections: [
          {
            integration_id: "@appstrate/gmail",
            name: "Gmail",
            source: "own",
            default_tools: ["api_call"],
          },
          { integration_id: "@appstrate/clickup", name: "ClickUp", source: "shared" },
        ],
      },
      BASE_OPTS,
    );
    expect(out).toContain("## Your context");
    expect(out).toContain("Ada Lovelace (ada@acme.com)");
    expect(out).toContain('whose role is "member"');
    expect(out).toContain("`@appstrate/gmail`");
    // Declared default is rendered inline so the model knows what it inherits.
    expect(out).toContain("(own; default: api_call)");
    // No declared default → an explicit "select tools yourself" signal.
    expect(out).toContain("(shared; no default — you must select tools explicitly)");
    // Connected integrations are rendered as DATA ONLY. The verbatim-id rule,
    // like the preference order and the tool-catalog rule, lives outside this
    // block — in the persona (`buildSystemPrompt`) and in the platform MCP server instructions.
    expect(out).not.toContain("Use the `@scope/name` id verbatim");
  });

  it("renders the wildcard and empty default-tools markers", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        connections: [
          { integration_id: "@acme/all", name: "AllTools", source: "own", default_tools: "*" },
          // An explicit empty default also reads as "no default" (must select).
          { integration_id: "@acme/none", name: "NoneTools", source: "own", default_tools: [] },
        ],
      },
      BASE_OPTS,
    );
    expect(out).toContain("(own; default: all tools)");
    expect(out).toContain("no default — you must select tools explicitly");
  });

  it("tells a draft-only agent apart by whether THIS caller may run its draft", () => {
    // `published: false` alone does not say "run it with version=draft": the
    // run route reserves the draft to whoever may WRITE the agent, so telling
    // the model otherwise buys a 403 loop. The two rows below differ ONLY in
    // `home_writable`, so the contrast is that flag and nothing else.
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        agents: [
          {
            package_id: "@acme/mine",
            display_name: "Mine",
            takes_input: false,
            published: false,
            home_writable: true,
          },
          {
            package_id: "@acme/theirs",
            display_name: "Theirs",
            takes_input: false,
            published: false,
            home_writable: false,
          },
        ],
      },
      BASE_OPTS,
    );
    expect(out).toContain("`@acme/mine` — Mine (takes input: no; draft only, yours to run");
    expect(out).toContain("`@acme/theirs` — Theirs (takes input: no; draft only, not runnable");
    // The one the caller cannot write must not be advertised as runnable.
    const theirs = out.split("\n").find((line) => line.includes("@acme/theirs"))!;
    expect(theirs).not.toContain("version=draft");
  });

  it("renders the space role and the turn's permissions as joinable data", () => {
    // Same `resource:action` vocabulary as an operation's `required_permissions`
    // and the 403 hint, so the model joins the two itself. Sorted, so the block
    // stays byte-stable across turns (one cache breakpoint covers it).
    const identity = { user: { name: "Ada" }, org: { role: "member" } };
    const out = formatCallerContext(identity, {
      capabilities: caps(BUILDER),
      rolePreview: false,
      spaceRole: "builder",
      permissions: ["mcp:invoke", "agents:read", "mcp:read"],
      skills: DEFAULT_SKILL_SELECTION,
    });
    expect(out).toContain("Role in this space: builder");
    expect(out).not.toContain("role preview active");
    expect(out).toContain("Permissions this turn: agents:read, mcp:invoke, mcp:read");
  });

  it("marks the role line as a preview, omits it without a role, and says `none` for an empty set", () => {
    const identity = { user: { name: "Ada" }, org: { role: "member" } };
    const preview = formatCallerContext(identity, {
      capabilities: caps([]),
      rolePreview: true,
      spaceRole: "operator",
      permissions: [],
      skills: DEFAULT_SKILL_SELECTION,
    });
    expect(preview).toContain("Role in this space: operator — role preview active");
    expect(preview).toContain("Permissions this turn: none");
    const roleless = formatCallerContext(identity, {
      capabilities: caps([]),
      rolePreview: false,
      spaceRole: null,
      permissions: ["mcp:read"],
      skills: DEFAULT_SKILL_SELECTION,
    });
    expect(roleless).not.toContain("Role in this space:");
    expect(roleless).toContain("Permissions this turn: mcp:read");
    expect(roleless).not.toContain("Current space:");
  });

  it("blames the role preview, not the human, for a draft it cannot run", () => {
    // Under `X-View-As` the persona narrows the permission set and
    // `home_writable` follows it, so the SAME human reads this line about their
    // own draft. Telling them they do not author it is a lie the preview causes.
    const raw = {
      user: { name: "Ada" },
      org: { role: "member" },
      agents: [
        {
          package_id: "@acme/mine",
          display_name: "Mine",
          takes_input: false,
          published: false,
          home_writable: false,
        },
      ],
    };
    const preview = formatCallerContext(raw, {
      ...BASE_OPTS,
      capabilities: caps(NO_AUTHORING),
      rolePreview: true,
    });
    expect(preview).toContain("draft only, not runnable under this role preview");
    expect(preview).not.toContain("you do not author it");
    // Outside a preview the permission set IS the caller's, so the fact holds.
    const real = formatCallerContext(raw, { ...BASE_OPTS, capabilities: caps(NO_AUTHORING) });
    expect(real).toContain("draft only, not runnable — nothing published and you do not author it");
    expect(real).not.toContain("role preview");
  });

  it("gives ONE cause-neutral reason for a writable draft the turn cannot run", () => {
    // `home_writable` is the HUMAN's answer: `/api/me/context` is dispatched
    // with the caller's raw headers, so it sees neither the preview nor the
    // authoring toggle. The turn holding no `agents:write` is therefore all this
    // line can know — naming the preview as the cause was a guess, and wrong
    // whenever the toggle was what dropped it.
    const raw = {
      user: { name: "Ada" },
      org: { role: "member" },
      agents: [
        {
          package_id: "@acme/mine",
          display_name: "Mine",
          takes_input: false,
          published: false,
          home_writable: true,
        },
      ],
    };
    const hint = "; draft, not runnable in this turn — this turn does not hold agent authoring";
    expect(
      formatCallerContext(raw, {
        ...BASE_OPTS,
        capabilities: caps(NO_AUTHORING),
        rolePreview: true,
      }),
    ).toContain(hint);
    expect(formatCallerContext(raw, { ...BASE_OPTS, capabilities: caps(NO_AUTHORING) })).toContain(
      hint,
    );
    // Control: with authoring held, the same draft is advertised as runnable.
    expect(formatCallerContext(raw, BASE_OPTS)).toContain("draft only, yours to run");
  });

  it("advertises no draft as runnable when the turn may not author agents", () => {
    // The turn's token then lacks `agents:write`, and a draft launch 403s.
    const draft = {
      package_id: "@acme/mine",
      display_name: "Mine",
      takes_input: false,
      published: false,
      home_writable: true,
    };
    const raw = { user: { name: "Ada" }, org: { role: "member" }, agents: [draft] };
    expect(formatCallerContext(raw, BASE_OPTS)).toContain("yours to run");
    const off = formatCallerContext(raw, { ...BASE_OPTS, capabilities: caps(NO_AUTHORING) });
    expect(off).toContain(
      "draft, not runnable in this turn — this turn does not hold agent authoring",
    );
    // Distinct from the "draft only, not runnable" rule, which means never runnable.
    expect(off).not.toContain("draft only, not runnable");
    expect(off).not.toContain("version=draft");
  });

  it("lists skills whatever the turn's authoring grant — the chat loads them itself", () => {
    const raw = {
      user: { name: "Ada" },
      org: { role: "member" },
      skills: [{ package_id: "@acme/research", display_name: "Research" }],
    };
    for (const permissions of [BUILDER, NO_AUTHORING]) {
      const out = formatCallerContext(raw, { ...BASE_OPTS, capabilities: caps(permissions) });
      expect(out).toContain("## Skills");
      expect(out).toContain("`@acme/research`");
    }
  });

  it("indexes the platform defaults and tags each line (platform) or (pinned)", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        requested_skills: [
          {
            package_id: "@appstrate/copilot",
            display_name: "Agent Copilot",
            description: "Builds an agent with the user.",
            version: "1.0.0",
            source: "system",
          },
          { package_id: "@acme/mine", display_name: "Mine", description: "Pinned.", version: null },
        ],
      },
      { ...BASE_OPTS, skills: { catalogue: true, pinned: ["@acme/mine"] } },
    );
    expect(out).toContain("## Skills");
    expect(out).toContain("- `@acme/mine` (pinned) — Mine: Pinned.");
    expect(out).toContain(
      "- `@appstrate/copilot` (v1.0.0) (platform) — Agent Copilot: Builds an agent",
    );
    // Sorted by id, so the pin comes first here — not by "pins first".
    expect(out.indexOf("@acme/mine")).toBeLessThan(out.indexOf("@appstrate/copilot"));
  });

  it("renders the catalogue under its lead line, minus what is already indexed", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        requested_skills: [
          { package_id: "@appstrate/copilot", display_name: "Agent Copilot", source: "system" },
        ],
        skills: [
          { package_id: "@appstrate/copilot", display_name: "Agent Copilot", source: "system" },
          { package_id: "@acme/pdf", display_name: "PDF", description: "Reads PDFs." },
        ],
        skills_truncated: true,
      },
      { ...BASE_OPTS, skills: { catalogue: true, pinned: [] } },
    );
    expect(out).toContain("Other skills in this space (not loaded):");
    expect(out).toContain("- `@acme/pdf` — PDF: Reads PDFs.");
    expect(out).toContain("(list truncated)");
    // The indexed one is NOT repeated in the catalogue.
    expect(out.split("@appstrate/copilot")).toHaveLength(2);
    expect(out).not.toContain("###");
    // A catalogue line is neither a default nor a pin.
    expect(out).not.toContain("`@acme/pdf` (platform)");
  });

  it("renders ONE `## Skills` heading when only the catalogue has rows", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        requested_skills: [],
        skills: [{ package_id: "@acme/pdf", display_name: "PDF" }],
      },
      { ...BASE_OPTS, skills: { catalogue: true, pinned: [] } },
    );
    expect(out.split("## Skills")).toHaveLength(2);
    expect(out).not.toContain("###");
    expect(out.indexOf("## Skills")).toBeLessThan(
      out.indexOf("Other skills in this space (not loaded):"),
    );
    expect(out).toContain("- `@acme/pdf` — PDF");
  });

  it("drops the catalogue (and its truncation marker) when the catalogue is off", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        requested_skills: [
          { package_id: "@appstrate/copilot", display_name: "Agent Copilot", source: "system" },
        ],
        skills: [{ package_id: "@acme/pdf", display_name: "PDF" }],
        skills_truncated: true,
      },
      { ...BASE_OPTS, skills: { catalogue: false, pinned: [] } },
    );
    expect(out).toContain("## Skills");
    expect(out).not.toContain("Other skills in this space");
    expect(out).not.toContain("@acme/pdf");
    expect(out).not.toContain("(list truncated)");
  });

  it("still indexes the defaults and the pins when the catalogue is off", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        requested_skills: [
          { package_id: "@appstrate/copilot", display_name: "Agent Copilot", source: "system" },
          { package_id: "@acme/mine", display_name: "Mine", description: "Pinned." },
        ],
        skills: [{ package_id: "@acme/pdf", display_name: "PDF" }],
      },
      { ...BASE_OPTS, skills: { catalogue: false, pinned: ["@acme/mine"] } },
    );
    expect(out).toContain("- `@acme/mine` (pinned) — Mine: Pinned.");
    expect(out).toContain("- `@appstrate/copilot` (platform) — Agent Copilot");
    expect(out).not.toContain("@acme/pdf");
  });

  it("says a pinned skill could not be resolved, and nothing about a missing default", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        requested_skills: [],
        unresolved_skills: ["@acme/gone", "@appstrate/copilot"],
      },
      { ...BASE_OPTS, skills: { catalogue: true, pinned: ["@acme/gone"] } },
    );
    expect(out).toContain("`@acme/gone` is pinned to this conversation but is not available here");
    // A platform default missing from the deployment is an operator's problem,
    // logged at warn — never a line the model has to reason about.
    expect(out).not.toContain("@appstrate/copilot");
  });

  it("omits the heading entirely when nothing resolves and nothing is catalogued", () => {
    const out = formatCallerContext(
      { user: { name: "Ada" }, org: { role: "member" }, skills: [], requested_skills: [] },
      { ...BASE_OPTS, skills: { catalogue: true, pinned: [] } },
    );
    expect(out).not.toContain("## Skills");
  });

  it("says nothing about the draft for a PUBLISHED agent", () => {
    // The negative control: the suffix is about the draft, not about authorship
    // — an author of a published agent gets the plain line.
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        agents: [
          {
            package_id: "@acme/shipped",
            display_name: "Shipped",
            takes_input: true,
            published: true,
            home_writable: true,
          },
        ],
      },
      BASE_OPTS,
    );
    expect(out).toContain("`@acme/shipped` — Shipped (takes input: yes)");
    expect(out).not.toContain("draft only");
  });

  it("states explicitly when the user has no connected integrations", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada", email: "ada@acme.com" },
        org: { role: "owner" },
        connections: [],
      },
      BASE_OPTS,
    );
    expect(out).toContain("no connected integrations yet");
  });

  it("falls back to email, then a generic label, when the name is missing", () => {
    expect(
      formatCallerContext({ user: { email: "ada@acme.com" }, org: { role: "guest" } }, BASE_OPTS),
    ).toContain("assisting ada@acme.com");
    expect(formatCallerContext({ org: { role: "guest" } }, BASE_OPTS)).toContain(
      "assisting the user",
    );
  });

  it("omits the role clause when the role is absent", () => {
    const out = formatCallerContext({ user: { name: "Ada" }, connections: [] }, BASE_OPTS);
    expect(out).toContain("assisting Ada.");
    expect(out).not.toContain("role in this organization");
  });

  it("renders the runnable-agent block with invokable id and input flag", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada", email: "ada@acme.com" },
        org: { role: "member" },
        connections: [],
        agents: [
          {
            package_id: "@appstrate/triage",
            display_name: "Inbox Triage",
            description: "Sorts incoming email.",
            takes_input: false,
          },
          {
            package_id: "@acme/report",
            display_name: "Report",
            description: "Builds a report.",
            takes_input: true,
          },
        ],
      },
      BASE_OPTS,
    );
    expect(out).toContain("## Existing agents you can run");
    expect(out).toContain("`@appstrate/triage`");
    expect(out).toContain("Inbox Triage: Sorts incoming email.");
    expect(out).toContain("(takes input: no)");
    expect(out).toContain("`@acme/report`");
    expect(out).toContain("(takes input: yes)");
    // Data only — the "prefer an existing agent" rule lives in `buildSystemPrompt`.
    expect(out).not.toContain("Prefer running an existing agent");
    expect(out).not.toContain("(list truncated)");
  });

  it("marks the agent list as truncated without restating how to page it", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        connections: [],
        agents: [{ package_id: "@appstrate/triage", takes_input: false }],
        agents_truncated: true,
      },
      BASE_OPTS,
    );
    // The marker is data; `buildSystemPrompt` owns what to DO about it (listAgents).
    expect(out).toContain("(list truncated)");
    expect(out).not.toContain('`operation_id: "listAgents"`');
  });

  it("renders a context block from agents alone (no identity/connections)", () => {
    const out = formatCallerContext(
      {
        agents: [{ package_id: "@appstrate/triage", takes_input: false }],
      },
      BASE_OPTS,
    );
    expect(out).toContain("## Existing agents you can run");
    expect(out).toContain("`@appstrate/triage`");
  });

  it("omits the agent block when there are no runnable agents", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        connections: [],
        agents: [],
      },
      BASE_OPTS,
    );
    expect(out).not.toContain("Existing agents you can run");
  });

  it("renders each skill line with id, version and label, dropping what says nothing", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada", email: "ada@acme.com" },
        org: { role: "member" },
        connections: [],
        skills: [
          {
            package_id: "@appstrate/web-research",
            display_name: "Web Research",
            description: "Multi-source web search.",
            version: "1.2.0",
          },
          {
            package_id: "@acme/pdf",
            display_name: "PDF",
            description: "Reads PDFs.",
            version: null,
          },
          // A display name that only repeats the id is not worth a second copy.
          { package_id: "@acme/bare", display_name: "@acme/bare", description: "Bare." },
        ],
      },
      BASE_OPTS,
    );
    expect(out).toContain("## Skills");
    expect(out).toContain("`@appstrate/web-research`");
    expect(out).toContain("(v1.2.0)");
    expect(out).toContain("Web Research: Multi-source web search.");
    expect(out).toContain("`@acme/pdf`");
    // No version → no version suffix rendered.
    expect(out).not.toContain("@acme/pdf` (v");
    expect(out).toContain("- `@acme/bare` — Bare.");
    // Data only — the `dependencies.skills` rule lives in `buildSystemPrompt` (when the turn may author).
    expect(out).not.toContain("dependencies.skills");
    expect(out).not.toContain("(list truncated)");
  });

  it("marks the skill list as truncated without restating how to page it", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        connections: [],
        skills: [{ package_id: "@appstrate/web-research", version: "1.2.0" }],
        skills_truncated: true,
      },
      BASE_OPTS,
    );
    // The marker is data; `buildSystemPrompt` owns what to DO about it (listSkills).
    // That instruction must name the operation: `search_operations` ranks
    // `listSkills` below every create/delete variant, so a keyword search is
    // not a reliable path back to the truncated list.
    expect(out).toContain("(list truncated)");
    expect(out).not.toContain('`operation_id: "listSkills"`');
  });

  it("renders a context block from skills alone (no identity/connections/agents)", () => {
    const out = formatCallerContext(
      {
        skills: [{ package_id: "@appstrate/web-research", version: "1.2.0" }],
      },
      BASE_OPTS,
    );
    expect(out).toContain("## Skills");
    expect(out).toContain("`@appstrate/web-research`");
  });

  it("omits the skills block when there are no installed skills", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        connections: [],
        skills: [],
      },
      BASE_OPTS,
    );
    expect(out).not.toContain("## Skills");
  });

  it("returns an empty string for an unusable payload (so injection is skipped)", () => {
    expect(formatCallerContext({}, BASE_OPTS)).toBe("");
    expect(formatCallerContext(null, BASE_OPTS)).toBe("");
    expect(
      formatCallerContext({ user: { name: null, email: null }, org: { role: null } }, BASE_OPTS),
    ).toBe("");
  });

  it("renders org name/slug and grounds date/language from the server (UTC + fr)", () => {
    const out = formatCallerContext(
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

  it("does NOT render recent runs — they would bust the prompt cache every turn", () => {
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        recent_runs: [
          {
            package_id: "@appstrate/triage",
            status: "failed",
            run_number: 7,
            started_at: "2026-06-25T09:00:00.000Z",
            error: "Gmail token expired",
          },
          { package_id: "@acme/report", status: "success", run_number: 6 },
        ],
      },
      BASE_OPTS,
    );
    // The payload field still exists (it backs the MCP `get_me` tool); the
    // RENDERING is what was removed. `started_at` rewrote the system prompt on
    // every turn that launched a run, invalidating its single cache breakpoint
    // and the conversation history behind it. `buildSystemPrompt` tells the model to
    // call `listRuns` instead.
    expect(out).not.toContain("The user's recent runs");
    expect(out).not.toContain("@appstrate/triage");
    expect(out).not.toContain("Gmail token expired");
    expect(out).not.toContain("2026-06-25");
  });

  it("returns an empty block when recent_runs is the only usable field", () => {
    expect(
      formatCallerContext(
        {
          recent_runs: [{ package_id: "@acme/report", status: "success", run_number: 1 }],
        },
        BASE_OPTS,
      ),
    ).toBe("");
  });

  it("is byte-identical for the same inputs, index and catalogue included", () => {
    // The whole block is ONE prompt-cache breakpoint. A skills section that
    // re-ordered itself between two turns of the same session would invalidate
    // the cached prefix and the conversation history behind it.
    const ctx = {
      user: { name: "Ada" },
      org: { role: "member" },
      requested_skills: [
        {
          package_id: "@appstrate/web-search",
          display_name: "Web Search",
          version: "1.0.0",
          source: "system",
        },
        {
          package_id: "@appstrate/copilot",
          display_name: "Copilot",
          version: "1.0.0",
          source: "system",
        },
        { package_id: "@acme/mine", display_name: "Mine" },
      ],
      skills: [{ package_id: "@acme/pdf", display_name: "PDF" }],
      unresolved_skills: ["@acme/gone"],
    };
    const opts = {
      ...BASE_OPTS,
      skills: { catalogue: true, pinned: ["@acme/mine", "@acme/gone"] },
    };
    const at = new Date("2026-06-25T09:05:00.000Z");
    expect(formatCallerContext(ctx, { ...opts, now: at })).toBe(
      formatCallerContext(ctx, { ...opts, now: at }),
    );
    // And the rendered section is the one the resolver decided, in id order.
    const out = formatCallerContext(ctx, { ...opts, now: at });
    const ids = out
      .split("\n")
      .filter((line) => line.startsWith("- `@"))
      .map((line) => line.slice(3, line.indexOf("`", 3)));
    expect(ids).toEqual([
      "@acme/mine",
      "@appstrate/copilot",
      "@appstrate/web-search",
      // …then the catalogue block.
      "@acme/pdf",
    ]);
    expect(out).toContain("`@acme/gone` is pinned to this conversation");
  });

  it("is byte-identical across a 45-minute gap (the cache invariant)", () => {
    const ctx = {
      user: { name: "Ada", email: "ada@acme.com" },
      org: { role: "member", name: "Acme", slug: "acme" },
      connections: [{ integration_id: "@appstrate/gmail", name: "Gmail", source: "own" }],
      agents: [{ package_id: "@appstrate/triage", takes_input: false }],
      skills: [{ package_id: "@appstrate/web-research", version: "1.2.0" }],
    };
    const at = new Date("2026-06-25T09:05:00.000Z");
    const later = new Date("2026-06-25T09:50:00.000Z");
    expect(formatCallerContext(ctx, { ...BASE_OPTS, now: later })).toBe(
      formatCallerContext(ctx, { ...BASE_OPTS, now: at }),
    );
    // And the rendered hour is the floor, not the raw stamp.
    expect(formatCallerContext(ctx, { ...BASE_OPTS, now: at })).toContain(
      "2026-06-25T09:00:00.000Z",
    );
    // No time-of-day precision survives anywhere in the block.
    expect(formatCallerContext(ctx, { ...BASE_OPTS, now: at })).not.toMatch(
      /T\d{2}:(?!00:00\.000Z)/,
    );
    // `opts.now` exists only to make the invariant testable, so the DEFAULT
    // clock has to be floored by the same code — a regression that floored the
    // injected stamp alone would leave everything above green while every real
    // turn re-rendered the block.
    expect(formatCallerContext(ctx, BASE_OPTS)).toMatch(
      /Current date and time: \d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z \(UTC, rounded to the hour\)/,
    );
  });
});

describe("buildCallerContextBlock", () => {
  const user = { id: "u_1", name: "Ada", email: "ada@acme.com" };

  it("builds the block from the dispatched GET /api/me/context payload", async () => {
    const payload = {
      user: { name: "Ada", email: "ada@acme.com" },
      org: { role: "member", name: "Acme", slug: "acme" },
      connections: [{ integration_id: "@appstrate/gmail", name: "Gmail", source: "own" }],
      agents: [{ package_id: "@appstrate/triage", takes_input: false }],
    };
    const { deps, lastRequest } = fakeDeps(() => Response.json(payload));
    const out = await buildCallerContextBlock(fakeContext({ orgRole: "member" }), {
      origin: "http://127.0.0.1:3000",
      headers: { cookie: "session=abc", "x-org-id": "org_1" },
      spaceId: "spc_1",
      user,
      deps,
      capabilities: caps(BUILDER),
      permissions: ["mcp:read", "mcp:invoke"],
      skills: DEFAULT_SKILL_SELECTION,
    });
    // Block is rendered from the dispatched payload, not from request context.
    expect(out).toContain("`@appstrate/gmail`");
    expect(out).toContain("## Existing agents you can run");
    // The path parameter of every space-scoped operation, as data.
    expect(out).toContain("Current space: `spc_1`");
    // The space-scoped read carries the resolved space id on the dispatch.
    const req = lastRequest()!;
    expect(new URL(req.url).pathname).toBe("/api/me/context");
    expect(req.headers.get("x-space-id")).toBe("spc_1");
    expect(req.headers.get("cookie")).toBe("session=abc");
  });

  it("asks the platform to resolve the platform defaults plus the session's pins", async () => {
    const { deps, lastRequest } = fakeDeps(() => Response.json({ user: { name: "Ada" } }));
    await buildCallerContextBlock(fakeContext({ orgRole: "member" }), {
      origin: "http://127.0.0.1:3000",
      headers: {},
      spaceId: "spc_1",
      user,
      deps,
      capabilities: caps(BUILDER),
      permissions: ["mcp:read", "mcp:invoke"],
      // A pin that is ALSO a default must not be asked for twice, and the
      // order must not depend on how the session stored it.
      skills: { catalogue: true, pinned: ["@acme/mine", "@appstrate/copilot"] },
    });
    const asked = new URL(lastRequest()!.url).searchParams.get("skills");
    expect(asked).toBe(
      ["@acme/mine", ...PLATFORM_DEFAULT_SKILLS].sort().join(","), // sorted, deduped
    );
  });

  it("drops the runnable-agents section for a turn that cannot launch", async () => {
    const payload = {
      user: { name: "Ada", email: "ada@acme.com" },
      org: { role: "member" },
      agents: [{ package_id: "@appstrate/triage", takes_input: false }],
    };
    const { deps } = fakeDeps(() => Response.json(payload));
    const out = await buildCallerContextBlock(fakeContext({ orgRole: "member" }), {
      origin: "http://127.0.0.1:3000",
      headers: {},
      spaceId: "spc_1",
      user,
      deps,
      capabilities: caps([]),
      permissions: ["mcp:read", "mcp:invoke"],
      skills: DEFAULT_SKILL_SELECTION,
    });
    expect(out).not.toContain("## Existing agents you can run");
    expect(out).not.toContain("@appstrate/triage");
    expect(out).toContain("Ada (ada@acme.com)");
  });

  it("derives the role preview from the persona on the request context", async () => {
    const payload = {
      user: { name: "Ada", email: "ada@acme.com" },
      org: { role: "member" },
      agents: [
        {
          package_id: "@acme/mine",
          display_name: "Mine",
          takes_input: false,
          published: false,
          home_writable: false,
        },
      ],
    };
    const { deps } = fakeDeps(() => Response.json(payload));
    const args = {
      origin: "http://127.0.0.1:3000",
      headers: {},
      spaceId: "spc_1",
      user,
      deps,
      capabilities: caps(NO_AUTHORING),
      permissions: ["mcp:read", "mcp:invoke"],
      skills: DEFAULT_SKILL_SELECTION,
    };
    const preview = await buildCallerContextBlock(
      fakeContext({
        orgRole: "owner",
        viewAs: { orgId: "org_1", orgRole: "member", space: null },
      }),
      args,
    );
    expect(preview).toContain("draft only, not runnable under this role preview");
    expect(preview).not.toContain("you do not author it");
    const real = await buildCallerContextBlock(fakeContext({ orgRole: "owner" }), args);
    expect(real).toContain("you do not author it");
  });

  it("names the current space's role, which is already resolved under the persona", async () => {
    // A persona may preview a DIFFERENT space than `X-Space-Id` — the ref then
    // applies to neither this space nor this block (`personaSpaceMember`).
    // `applySpacePermissions` resolved `spaceRole` for THIS space under the
    // persona, so it is the one answer that agrees with the permissions line.
    const payload = { user: { name: "Ada", email: "ada@acme.com" }, org: { role: "member" } };
    const { deps } = fakeDeps(() => Response.json(payload));
    const args = {
      origin: "http://127.0.0.1:3000",
      headers: {},
      spaceId: "spc_1",
      user,
      deps,
      capabilities: caps(NO_AUTHORING),
      permissions: ["mcp:read", "mcp:invoke"],
      skills: DEFAULT_SKILL_SELECTION,
    };
    const preview = await buildCallerContextBlock(
      fakeContext({
        orgRole: "owner",
        spaceRole: { kind: "preset", preset: "builder" },
        viewAs: {
          orgId: "org_1",
          orgRole: "member",
          space: { spaceId: "spc_other", role: { kind: "preset", preset: "operator" } },
        },
      }),
      args,
    );
    expect(roleLine(preview)).toBe("Role in this space: builder — role preview active");
    // A custom bundle is named by its own name; without a preview, no marker.
    const custom = await buildCallerContextBlock(
      fakeContext({
        orgRole: "member",
        spaceRole: { kind: "custom", role: { id: "srl_1", name: "Analyste" } },
      }),
      args,
    );
    expect(roleLine(custom)).toBe("Role in this space: Analyste");
  });

  it("falls back to identity-only when the dispatch 400s (no app context)", async () => {
    const { deps } = fakeDeps(() => new Response(null, { status: 400 }));
    const out = await buildCallerContextBlock(fakeContext({ orgRole: "member" }), {
      origin: "http://127.0.0.1:3000",
      headers: {},
      spaceId: "spc_1",
      user,
      deps,
      capabilities: caps(BUILDER),
      permissions: ["mcp:read", "mcp:invoke"],
      skills: DEFAULT_SKILL_SELECTION,
    });
    expect(out).toContain("Ada (ada@acme.com)");
    expect(out).toContain("Current space: `spc_1`");
  });

  it("degrades to no block on any other dispatch failure", async () => {
    const { deps } = fakeDeps(() => new Response(null, { status: 503 }));
    const out = await buildCallerContextBlock(fakeContext({ orgRole: "member" }), {
      origin: "http://127.0.0.1:3000",
      headers: {},
      spaceId: "spc_1",
      user,
      deps,
      capabilities: caps(BUILDER),
      permissions: ["mcp:read", "mcp:invoke"],
      skills: DEFAULT_SKILL_SELECTION,
    });
    expect(out).toBe("");
  });
});
