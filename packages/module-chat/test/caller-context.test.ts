// SPDX-License-Identifier: Apache-2.0

/**
 * The chat fetches GET /api/me/context (the `get_me` payload) and injects a
 * "## Your context" block into the system prompt so the agent knows who it is
 * acting for, their role, and which integrations are already connected.
 * `formatCallerContext` renders that block from the raw payload and returns ""
 * when there is nothing useful to inject (so the caller skips it).
 */

import { describe, expect, it } from "bun:test";
import { formatCallerContext } from "../src/chat-stream.ts";

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
    expect(out).toContain('role in this organization is "member"');
    expect(out).toContain("`@appstrate/gmail`");
    // Declared default is rendered inline so the model knows what it inherits.
    expect(out).toContain("(own; default: api_call)");
    // No declared default → an explicit "select tools yourself" signal.
    expect(out).toContain("(shared; no default — you must select tools explicitly)");
    expect(out).toContain("Prefer these");
  });

  it("renders the wildcard default and the on-demand inspect instruction", () => {
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
    // The catalog is one describe_operation away — teach the model to fetch it.
    expect(out).toContain("describe_operation on `GET /api/integrations/{packageId}`");
    expect(out).toContain("`[]` means no tools");
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
      formatCallerContext({ user: { email: "ada@acme.com" }, org: { role: "viewer" } }),
    ).toContain("assisting ada@acme.com");
    expect(formatCallerContext({ org: { role: "viewer" } })).toContain("assisting the user");
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
    expect(out).toContain("Prefer running an existing agent");
    expect(out).not.toContain("use the search_operations tool");
  });

  it("adds the search_operations note only when the agent list is truncated", () => {
    const out = formatCallerContext({
      user: { name: "Ada" },
      org: { role: "member" },
      connections: [],
      agents: [{ package_id: "@appstrate/triage", takes_input: false }],
      agents_truncated: true,
    });
    expect(out).toContain("use the search_operations tool");
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
    expect(out).toContain("dependencies.skills");
    // Not truncated → no search hint within the skills section.
    expect(out).not.toContain("More skills are available");
  });

  it("adds the skill search hint only when the skill list is truncated", () => {
    const out = formatCallerContext({
      user: { name: "Ada" },
      org: { role: "member" },
      connections: [],
      skills: [{ package_id: "@appstrate/web-research", version: "1.2.0" }],
      skills_truncated: true,
    });
    expect(out).toContain("More skills are available");
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
});
