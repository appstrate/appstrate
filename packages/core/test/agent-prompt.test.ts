// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isValidSkillName } from "@appstrate/afps-shared/companion-files";
import {
  agentPromptDescription,
  agentPromptName,
  renderAgentPrompt,
  scopeCollisionPromptName,
  spaceCollisionPromptName,
  type AgentLaunchView,
} from "../src/agent-prompt.ts";
import { CONNECTION_RESOLUTION_WARNING_CODES } from "../src/integration.ts";
import { launchRunAndWait } from "../src/run-and-wait-client.ts";

const SPACE_ID = "spc_0f8fad5b";

function view(overrides: Partial<AgentLaunchView> = {}): AgentLaunchView {
  return {
    packageId: "@acme/weekly-report",
    spaceId: SPACE_ID,
    version: "1.2.0",
    title: "Weekly report",
    description: "Summarizes the week.",
    input: {
      schema: {
        type: "object",
        properties: { topic: { type: "string" }, tone: { type: "string" } },
        required: ["topic"],
      },
      values: { tone: "STORED-VALUE" },
      locked_fields: [],
    },
    ...overrides,
  };
}

function callOf(text: string): Record<string, unknown> {
  return JSON.parse(/```json\n\s*(\{"kind"[^\n]*)/.exec(text)![1]!) as Record<string, unknown>;
}

describe("agent prompt names", () => {
  it("prefixes the slugified agent name with run- inside 64 characters", () => {
    expect(agentPromptName("weekly-report")).toBe("run-weekly-report");
    expect(agentPromptName("Weekly Report!")).toBe("run-weekly-report");
    const long = agentPromptName("x".repeat(80));
    expect(long.length).toBe(64);
    expect(isValidSkillName(long)).toBe(true);
  });

  it("cuts the space, never the agent's name, and counts on when taken", () => {
    expect(spaceCollisionPromptName("report", "Beta Team", new Set(["run-report"]))).toBe(
      "run-beta-team-report",
    );
    expect(spaceCollisionPromptName("report", "Beta Team", new Set(["run-beta-team-report"]))).toBe(
      "run-beta-team-report-2",
    );
    const name = "n".repeat(60);
    expect(spaceCollisionPromptName(name, "Lab", new Set())).toBe(`run-${name}`.slice(0, 64));
  });

  it("names another agent with the same name run-<scope>-<name>", () => {
    expect(scopeCollisionPromptName("@other/report", new Set(["run-report"]))).toBe(
      "run-other-report",
    );
    expect(scopeCollisionPromptName("@other/report", new Set(["run-other-report"]))).toBe(
      "run-other-report-2",
    );
  });
});

describe("renderAgentPrompt", () => {
  it("describes the launch as metered", () => {
    expect(agentPromptDescription(view())).toBe(
      'Launches a metered run of the Appstrate agent "Weekly report": Summarizes the week.',
    );
    expect(agentPromptDescription(view({ description: " " }))).toBe(
      'Launches a metered run of the Appstrate agent "Weekly report"',
    );
  });

  it("inlines the contract, never a stored value", () => {
    const text = renderAgentPrompt(view());
    expect(text).toContain('"prompted": [\n      "topic"\n    ]');
    expect(text).toContain('"prefilled": [\n      "tone"\n    ]');
    expect(text).not.toContain("STORED-VALUE");
  });

  it("names this server's tools bare and the agent's space in every call", () => {
    const text = renderAgentPrompt(view());
    expect(text).not.toContain("mcp__");
    for (const tool of ["run_and_wait", "invoke_operation", "list_files"]) {
      expect(text).toContain(`\`${tool}\``);
    }
    expect(text).toContain(`"space_id": "${SPACE_ID}"`);
    for (const code of CONNECTION_RESOLUTION_WARNING_CODES) expect(text).toContain(`\`${code}\``);
  });

  it("includes the upload recipe only with an unlocked file field", () => {
    expect(renderAgentPrompt(view())).not.toContain("createUpload");
    const withFile = view({
      input: {
        schema: {
          type: "object",
          properties: { doc: { type: "string", format: "uri", contentMediaType: "text/csv" } },
        },
        values: {},
        locked_fields: [],
      },
    });
    expect(renderAgentPrompt(withFile)).toContain("`createUpload`");
    const locked = { ...withFile, input: { ...withFile.input, locked_fields: ["doc"] } };
    expect(renderAgentPrompt(locked)).not.toContain("createUpload");
  });

  it("ends with the request, or says there is none", () => {
    expect(renderAgentPrompt(view(), "  last week  ").endsWith("## Request\n\nlast week\n")).toBe(
      true,
    );
    expect(renderAgentPrompt(view()).endsWith("## Request\n\n(none)\n")).toBe(true);
    expect(renderAgentPrompt(view(), "").endsWith("## Request\n\n(none)\n")).toBe(true);
  });

  it("renders a run_and_wait call that core's launcher accepts", async () => {
    // The org-wide server consumes `space_id` before `run_and_wait` sees its arguments.
    const { space_id: spaceId, ...call } = callOf(renderAgentPrompt(view()));
    expect(spaceId).toBe(SPACE_ID);
    const requested: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return Response.json({ id: "run_1", status: "pending" }, { status: 201 });
    }) as typeof fetch;
    // Core refuses any argument name its MCP descriptor does not declare.
    const launched = await launchRunAndWait(call, {
      origin: "https://appstrate.test",
      headers: {},
      fetch: fakeFetch,
    });
    expect(launched.ok).toBe(true);
    expect(requested).toEqual([
      "https://appstrate.test/api/agents/@acme/weekly-report/run?version=1.2.0",
    ]);
  });

  it("refuses an id that is not @scope/name", () => {
    expect(() => renderAgentPrompt(view({ packageId: "weekly-report" }))).toThrow();
  });
});
