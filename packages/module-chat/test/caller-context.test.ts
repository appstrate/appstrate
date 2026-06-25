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
  it("renders identity, role, and connected integrations with their source", () => {
    const out = formatCallerContext({
      user: { name: "Ada Lovelace", email: "ada@acme.com" },
      org: { role: "member" },
      connections: [
        { integration_id: "@appstrate/gmail", name: "Gmail", source: "own" },
        { integration_id: "@appstrate/clickup", name: "ClickUp", source: "shared" },
      ],
    });
    expect(out).toContain("## Your context");
    expect(out).toContain("Ada Lovelace (ada@acme.com)");
    expect(out).toContain('role in this organization is "member"');
    expect(out).toContain("Gmail (own)");
    expect(out).toContain("ClickUp (shared)");
    expect(out).toContain("Prefer these");
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

  it("returns an empty string for an unusable payload (so injection is skipped)", () => {
    expect(formatCallerContext({})).toBe("");
    expect(formatCallerContext(null)).toBe("");
    expect(formatCallerContext({ user: { name: null, email: null }, org: { role: null } })).toBe(
      "",
    );
  });
});
