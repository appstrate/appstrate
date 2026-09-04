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
import type { ChatPlatformDeps } from "../src/platform-services.ts";

/** Minimal Hono-context stub exposing the `c.get(key)` reads the builder makes. */

function fakeContext(vars: Record<string, unknown>): any {
  return { get: (k: string) => vars[k] };
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

describe("formatCallerContext", () => {
  it("renders identity, role, and connected integrations with their default tools", () => {
    const out = formatCallerContext({
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
    });
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
    // block — in SYSTEM_PROMPT and in the platform MCP server instructions.
    expect(out).not.toContain("Use the `@scope/name` id verbatim");
  });

  it("renders the wildcard and empty default-tools markers", () => {
    const out = formatCallerContext({
      user: { name: "Ada" },
      org: { role: "member" },
      connections: [
        { integration_id: "@acme/all", name: "AllTools", source: "own", default_tools: "*" },
        // An explicit empty default also reads as "no default" (must select).
        { integration_id: "@acme/none", name: "NoneTools", source: "own", default_tools: [] },
      ],
    });
    expect(out).toContain("(own; default: all tools)");
    expect(out).toContain("no default — you must select tools explicitly");
  });

  it("states explicitly when the user has no connected integrations", () => {
    const out = formatCallerContext({
      user: { name: "Ada", email: "ada@acme.com" },
      org: { role: "owner" },
      connections: [],
    });
    expect(out).toContain("no connected integrations yet");
  });

  it("falls back to email, then a generic label, when the name is missing", () => {
    expect(
      formatCallerContext({ user: { email: "ada@acme.com" }, org: { role: "guest" } }),
    ).toContain("assisting ada@acme.com");
    expect(formatCallerContext({ org: { role: "guest" } })).toContain("assisting the user");
  });

  it("omits the role clause when the role is absent", () => {
    const out = formatCallerContext({ user: { name: "Ada" }, connections: [] });
    expect(out).toContain("assisting Ada.");
    expect(out).not.toContain("role in this organization");
  });

  it("renders the runnable-agent block with invokable id and input flag", () => {
    const out = formatCallerContext({
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
    });
    expect(out).toContain("## Existing agents you can run");
    expect(out).toContain("`@appstrate/triage`");
    expect(out).toContain("Inbox Triage: Sorts incoming email.");
    expect(out).toContain("(takes input: no)");
    expect(out).toContain("`@acme/report`");
    expect(out).toContain("(takes input: yes)");
    // Data only — the "prefer an existing agent" rule moved to SYSTEM_PROMPT.
    expect(out).not.toContain("Prefer running an existing agent");
    expect(out).not.toContain("(list truncated)");
  });

  it("marks the agent list as truncated without restating how to page it", () => {
    const out = formatCallerContext({
      user: { name: "Ada" },
      org: { role: "member" },
      connections: [],
      agents: [{ package_id: "@appstrate/triage", takes_input: false }],
      agents_truncated: true,
    });
    // The marker is data; SYSTEM_PROMPT owns what to DO about it (listAgents).
    expect(out).toContain("(list truncated)");
    expect(out).not.toContain('`operation_id: "listAgents"`');
  });

  it("renders a context block from agents alone (no identity/connections)", () => {
    const out = formatCallerContext({
      agents: [{ package_id: "@appstrate/triage", takes_input: false }],
    });
    expect(out).toContain("## Existing agents you can run");
    expect(out).toContain("`@appstrate/triage`");
  });

  it("omits the agent block when there are no runnable agents", () => {
    const out = formatCallerContext({
      user: { name: "Ada" },
      org: { role: "member" },
      connections: [],
      agents: [],
    });
    expect(out).not.toContain("Existing agents you can run");
  });

  it("renders the attachable-skills block with id, version and dependencies.skills guidance", () => {
    const out = formatCallerContext({
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
        { package_id: "@acme/pdf", display_name: "PDF", description: "Reads PDFs.", version: null },
      ],
    });
    expect(out).toContain("## Skills you can attach to an agent");
    expect(out).toContain("`@appstrate/web-research`");
    expect(out).toContain("(v1.2.0)");
    expect(out).toContain("Web Research: Multi-source web search.");
    expect(out).toContain("`@acme/pdf`");
    // No version → no version suffix rendered.
    expect(out).not.toContain("@acme/pdf` (v");
    // Data only — the `dependencies.skills` authoring rule moved to SYSTEM_PROMPT.
    expect(out).not.toContain("dependencies.skills");
    expect(out).not.toContain("(list truncated)");
  });

  it("marks the skill list as truncated without restating how to page it", () => {
    const out = formatCallerContext({
      user: { name: "Ada" },
      org: { role: "member" },
      connections: [],
      skills: [{ package_id: "@appstrate/web-research", version: "1.2.0" }],
      skills_truncated: true,
    });
    // The marker is data; SYSTEM_PROMPT owns what to DO about it (listSkills).
    // That instruction must name the operation: `search_operations` ranks
    // `listSkills` below every create/delete variant, so a keyword search is
    // not a reliable path back to the truncated list.
    expect(out).toContain("(list truncated)");
    expect(out).not.toContain('`operation_id: "listSkills"`');
  });

  it("renders a context block from skills alone (no identity/connections/agents)", () => {
    const out = formatCallerContext({
      skills: [{ package_id: "@appstrate/web-research", version: "1.2.0" }],
    });
    expect(out).toContain("## Skills you can attach to an agent");
    expect(out).toContain("`@appstrate/web-research`");
  });

  it("omits the skills block when there are no installed skills", () => {
    const out = formatCallerContext({
      user: { name: "Ada" },
      org: { role: "member" },
      connections: [],
      skills: [],
    });
    expect(out).not.toContain("Skills you can attach");
  });

  it("returns an empty string for an unusable payload (so injection is skipped)", () => {
    expect(formatCallerContext({})).toBe("");
    expect(formatCallerContext(null)).toBe("");
    expect(formatCallerContext({ user: { name: null, email: null }, org: { role: null } })).toBe(
      "",
    );
  });

  it("renders org name/slug and grounds date/language from the server (UTC + fr)", () => {
    const out = formatCallerContext({
      user: { name: "Ada", email: "ada@acme.com" },
      org: { role: "member", name: "Acme", slug: "acme" },
      connections: [],
    });
    expect(out).toContain('in the organization "Acme" (`acme`)');
    // No browser clock/timezone is forwarded to this route — always server UTC.
    expect(out).toContain("Current date and time:");
    expect(out).toContain("(UTC, rounded to the hour)");
    expect(out).toContain("Reply in the user's language (fr)");
  });

  it("does NOT render recent runs — they would bust the prompt cache every turn", () => {
    const out = formatCallerContext({
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
    });
    // The payload field still exists (it backs the MCP `get_me` tool); the
    // RENDERING is what was removed. `started_at` rewrote the system prompt on
    // every turn that launched a run, invalidating its single cache breakpoint
    // and the conversation history behind it. SYSTEM_PROMPT tells the model to
    // call `listRuns` instead.
    expect(out).not.toContain("The user's recent runs");
    expect(out).not.toContain("@appstrate/triage");
    expect(out).not.toContain("Gmail token expired");
    expect(out).not.toContain("2026-06-25");
  });

  it("returns an empty block when recent_runs is the only usable field", () => {
    expect(
      formatCallerContext({
        recent_runs: [{ package_id: "@acme/report", status: "success", run_number: 1 }],
      }),
    ).toBe("");
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
    expect(formatCallerContext(ctx, { now: later })).toBe(formatCallerContext(ctx, { now: at }));
    // And the rendered hour is the floor, not the raw stamp.
    expect(formatCallerContext(ctx, { now: at })).toContain("2026-06-25T09:00:00.000Z");
    // No time-of-day precision survives anywhere in the block.
    expect(formatCallerContext(ctx, { now: at })).not.toMatch(/T\d{2}:(?!00:00\.000Z)/);
    // `opts.now` exists only to make the invariant testable, so the DEFAULT
    // clock has to be floored by the same code — a regression that floored the
    // injected stamp alone would leave everything above green while every real
    // turn re-rendered the block.
    expect(formatCallerContext(ctx)).toMatch(
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
    });
    // Block is rendered from the dispatched payload, not from request context.
    expect(out).toContain("`@appstrate/gmail`");
    expect(out).toContain("## Existing agents you can run");
    // The space-scoped read carries the resolved space id on the dispatch.
    const req = lastRequest()!;
    expect(new URL(req.url).pathname).toBe("/api/me/context");
    expect(req.headers.get("x-space-id")).toBe("spc_1");
    expect(req.headers.get("cookie")).toBe("session=abc");
  });

  it("falls back to an identity-only block when there is no space context", async () => {
    // No spaceId → never dispatches; identity/role from request context.
    const { deps, lastRequest } = fakeDeps(() => new Response(null, { status: 500 }));
    const out = await buildCallerContextBlock(
      fakeContext({ orgRole: "owner", orgName: "Acme", orgSlug: "acme" }),
      { origin: "http://127.0.0.1:3000", headers: {}, spaceId: undefined, user, deps },
    );
    expect(out).toContain("Ada (ada@acme.com)");
    expect(out).toContain('whose role is "owner"');
    expect(lastRequest()).toBeNull();
  });

  it("falls back to identity-only when the dispatch 400s (no app context)", async () => {
    const { deps } = fakeDeps(() => new Response(null, { status: 400 }));
    const out = await buildCallerContextBlock(fakeContext({ orgRole: "member" }), {
      origin: "http://127.0.0.1:3000",
      headers: {},
      spaceId: "spc_1",
      user,
      deps,
    });
    expect(out).toContain("Ada (ada@acme.com)");
  });

  it("degrades to no block on any other dispatch failure", async () => {
    const { deps } = fakeDeps(() => new Response(null, { status: 503 }));
    const out = await buildCallerContextBlock(fakeContext({ orgRole: "member" }), {
      origin: "http://127.0.0.1:3000",
      headers: {},
      spaceId: "spc_1",
      user,
      deps,
    });
    expect(out).toBe("");
  });
});
