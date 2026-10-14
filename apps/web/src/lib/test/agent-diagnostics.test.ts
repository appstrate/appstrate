// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import type { AgentDiagnostic } from "../../hooks/use-agent-diagnostics";
import { agentDiagnosticText, agentDiagnosticCorrectionTarget } from "../agent-diagnostics";

await i18nReady;

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
  const AGENT = "/agents/@acme/demo";
  const target = (correction: AgentDiagnostic["correction"], code = "invalid_config") =>
    agentDiagnosticCorrectionTarget(diagnostic({ code, correction }), AGENT);

  it("opens the Paramètres section the backend names, carrying nothing else", () => {
    expect(target({ destination: "configuration", section: "inputs", params: {} })).toBe(
      `${AGENT}?agentSettings=inputs#settings`,
    );
    expect(target({ destination: "bundle", section: "skills", params: {} })).toBe(
      `${AGENT}?agentSettings=skills#settings`,
    );
    expect(target({ destination: "configuration", section: "connections", params: {} })).toBe(
      `${AGENT}?agentSettings=connections#settings`,
    );
  });

  it("opens the prompt file in Explorer for an empty prompt", () => {
    expect(target({ destination: "bundle", section: "prompt", params: {} }, "empty_prompt")).toBe(
      `${AGENT}?agentSettings=files&file=prompt.md#settings`,
    );
  });

  it("opens the schedule itself, or the agent's schedules", () => {
    expect(
      target({ destination: "schedule", section: "version", params: { scheduleId: "sched_1" } }),
    ).toBe("/schedules/sched_1");
    expect(target({ destination: "schedule", section: "version", params: {} })).toBe(
      `${AGENT}?agentSettings=schedules#settings`,
    );
  });

  it("falls back to the destination's first section for a section it does not know", () => {
    expect(target({ destination: "bundle", section: "brand_new", params: {} })).toBe(
      `${AGENT}?agentSettings=general#settings`,
    );
    expect(target({ destination: "configuration", section: null, params: {} })).toBe(
      `${AGENT}?agentSettings=model#settings`,
    );
  });

  it("links nowhere for an agent switched off here: the page's band holds the switch", () => {
    expect(
      target({ destination: "configuration", section: "inputs", params: {} }, "agent_not_active"),
    ).toBeNull();
  });
});

describe("agentDiagnosticText", () => {
  const fr = (key: string, options?: Record<string, unknown>) =>
    i18n.t(key, { ...options, ns: "agents", lng: "fr" });

  it("words every code the API can send in French, with its values", () => {
    const cases: Array<[Partial<AgentDiagnostic>, string]> = [
      [{ code: "empty_prompt" }, "Le prompt de l'agent est vide"],
      [
        {
          code: "missing_skill",
          correction: {
            destination: "bundle",
            section: "skills",
            params: { skill: "@acme/notes" },
          },
        },
        "Le skill @acme/notes",
      ],
      [
        {
          code: "not_connected",
          correction: {
            destination: "configuration",
            section: "connections",
            params: { integration: "@acme/gmail" },
          },
        },
        "Aucune connexion à @acme/gmail",
      ],
      [{ code: "model_not_configured" }, "Aucun modèle utilisable"],
      [
        {
          code: "model_credential_required",
          correction: { destination: "configuration", section: "model", params: { model: "GPT" } },
        },
        "Le modèle GPT demande votre clé perso",
      ],
      [
        {
          code: "pinned_model_unavailable",
          correction: {
            destination: "configuration",
            section: "model",
            params: { default_model: "Mistral Medium" },
          },
        },
        "le modèle par défaut (Mistral Medium)",
      ],
      [
        {
          code: "schedule_version_differs",
          correction: {
            destination: "schedule",
            section: "version",
            params: {
              scheduleId: "sched_1",
              schedule: "Nightly",
              schedule_version: "1.2.0",
              inspected_version: "draft",
            },
          },
        },
        "La planification « Nightly » exécute la version 1.2.0, alors que cette vue montre brouillon.",
      ],
    ];
    for (const [overrides, expected] of cases) {
      const text = agentDiagnosticText(diagnostic(overrides), fr);
      expect(text.explanation).toContain(expected);
      expect(text.title).not.toBe("Missing value");
      expect(text.explanation).not.toBe("A value is required.");
    }
  });

  it("has a sentence in both languages for every code it maps", () => {
    for (const code of [
      "agent_not_active",
      "integration_not_active",
      "insufficient_scopes",
      "override_outranked",
      "auth_key_serves_no_selected_tool",
      "integration_invalid_manifest",
    ]) {
      for (const lng of ["fr", "en"]) {
        const t = (key: string, options?: Record<string, unknown>) =>
          i18n.t(key, { ...options, ns: "agents", lng });
        const text = agentDiagnosticText(diagnostic({ code }), t);
        expect(text.title).not.toContain("detail.diagnostics");
        expect(text.explanation).not.toContain("detail.diagnostics");
      }
    }
  });

  it("keeps the server's text only for a code it does not know", () => {
    expect(agentDiagnosticText(diagnostic({ code: "brand_new_code" }), fr)).toEqual({
      title: "Missing value",
      explanation: "A value is required.",
    });
  });
});
