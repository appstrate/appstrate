// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { AgentDiagnostic } from "../../hooks/use-agent-diagnostics";
import {
  agentDiagnosticCorrectionTarget,
  agentDiagnosticLocateTarget,
  agentDiagnosticMapNodeId,
  requestedAgentDiagnostic,
} from "../agent-diagnostics";

function diagnostic(overrides: Partial<AgentDiagnostic> = {}): AgentDiagnostic {
  return {
    code: "invalid_config",
    severity: "blocking",
    title: "Missing value",
    explanation: "A value is required.",
    field: "config.period",
    target: { node: "config", item: "period" },
    correction: { destination: "configuration", section: "inputs", params: {} },
    recoverable_on_launch: false,
    ...overrides,
  };
}

describe("agent diagnostics routing", () => {
  it("adapts semantic targets without deriving a verdict", () => {
    expect(agentDiagnosticMapNodeId(diagnostic())).toBe("input_values");
    expect(agentDiagnosticMapNodeId(diagnostic({ target: { node: "toolbox", item: null } }))).toBe(
      "toolbox",
    );
    expect(agentDiagnosticMapNodeId(diagnostic({ target: { node: null, item: null } }))).toBeNull();
  });

  it("keeps repeated diagnostic codes addressable by field", () => {
    const first = diagnostic({ code: "schedule_version_differs", field: "schedules.one.version" });
    const second = diagnostic({ code: "schedule_version_differs", field: "schedules.two.version" });
    const target = agentDiagnosticLocateTarget(second, "/agents/@tractr/demo", "?foo=bar");
    const search = new URLSearchParams(target.search);
    expect(search.get("agentIssue")).toBe("schedule_version_differs");
    expect(search.get("agentIssueField")).toBe("schedules.two.version");
    expect(search.get("agentSettings")).toBe("map");
    expect(target.hash).toBe("#settings");
    expect(requestedAgentDiagnostic(search, [first, second])).toEqual(second);
  });

  it("uses the backend correction destination and section", () => {
    expect(
      agentDiagnosticCorrectionTarget(diagnostic(), "/agents/@tractr/demo", "?agentIssue=x"),
    ).toEqual({
      pathname: "/agents/@tractr/demo",
      search: "?agentSettings=inputs",
      hash: "#settings",
    });

    expect(
      agentDiagnosticCorrectionTarget(
        diagnostic({
          correction: { destination: "bundle", section: "skills", params: {} },
        }),
        "/agents/@tractr/demo",
        "",
      ),
    ).toEqual({
      pathname: "/agents/@tractr/demo",
      search: "?agentBundle=skills&agentSettings=files",
      hash: "#settings",
    });
  });
});
