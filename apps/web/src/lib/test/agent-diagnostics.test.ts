// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { AgentDiagnostic } from "../../hooks/use-agent-diagnostics";
import { agentDiagnosticText, agentDiagnosticCorrectionTarget } from "../agent-diagnostics";

function diagnostic(overrides: Partial<AgentDiagnostic> = {}): AgentDiagnostic {
  return {
    code: "invalid_config",
    severity: "blocking",
    title: "Missing value",
    explanation: "A value is required.",
    field: "config.period",
    correction: { destination: "configuration", section: "inputs", params: {} },
    recoverable_on_launch: false,
    ...overrides,
  };
}

describe("agent diagnostics routing", () => {
  it("uses the backend correction destination and section", () => {
    expect(agentDiagnosticCorrectionTarget(diagnostic(), "/agents/@tractr/demo", "")).toEqual({
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
      search: "?agentSettings=skills",
      hash: "#settings",
    });
  });
});

describe("agentDiagnosticText", () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    `${key}|${String(options?.model ?? "")}`;

  it("words the unavailable-model point by code, with the model that will serve", () => {
    const unavailable = diagnostic({
      code: "pinned_model_unavailable",
      title: "Model unavailable",
      correction: {
        destination: "configuration",
        section: "model",
        params: { defaultModel: "Mistral Medium" },
      },
    });
    expect(agentDiagnosticText(unavailable, t)).toEqual({
      title: "detail.diagnostics.pinnedModelUnavailable.title|",
      explanation: "detail.diagnostics.pinnedModelUnavailable.explanation|Mistral Medium",
    });
  });

  it("keeps the server's text for every other diagnostic", () => {
    expect(agentDiagnosticText(diagnostic(), t)).toEqual({
      title: "Missing value",
      explanation: "A value is required.",
    });
  });
});
