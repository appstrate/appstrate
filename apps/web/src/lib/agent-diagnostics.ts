// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical Agent diagnostics routing.
 *
 * The backend owns every verdict and correction. This module only adapts that
 * interface to SPA locations. It must never infer whether something is healthy
 * or invent a fix.
 */

import type { AgentDiagnostic } from "../hooks/use-agent-diagnostics";

/**
 * What a diagnostic says, in the reader's language. The server words every
 * diagnostic in English; the ones whose sentence carries a value the reader
 * must see (here the model that will serve) are worded by code in the bundles,
 * the others keep the server's text.
 */
export function agentDiagnosticText(
  diagnostic: AgentDiagnostic,
  t: (key: string, options?: Record<string, unknown>) => string,
): { title: string; explanation: string } {
  const model = diagnostic.correction.params.defaultModel;
  if (diagnostic.code === "pinned_model_unavailable" && model) {
    return {
      title: t("detail.diagnostics.pinnedModelUnavailable.title"),
      explanation: t("detail.diagnostics.pinnedModelUnavailable.explanation", { model }),
    };
  }
  return { title: diagnostic.title, explanation: diagnostic.explanation };
}

export function agentDiagnosticKey(diagnostic: AgentDiagnostic): string {
  return `${diagnostic.code}:${diagnostic.field}`;
}

export function agentDiagnosticCorrectionTarget(
  diagnostic: AgentDiagnostic,
  pathname: string,
  currentSearch: string,
) {
  if (diagnostic.correction.destination === "schedule") {
    const scheduleId = diagnostic.correction.params.scheduleId;
    if (scheduleId) return `/schedules/${scheduleId}`;
    const search = new URLSearchParams(currentSearch);
    search.set("agentSettings", "schedules");
    return { pathname, search: `?${search.toString()}`, hash: "#settings" };
  }

  const search = new URLSearchParams(currentSearch);
  if (diagnostic.correction.destination === "bundle") {
    // The bundle is edited in Paramètres › Définition, section by section.
    search.set("agentSettings", diagnostic.correction.section ?? "general");
    return { pathname, search: `?${search.toString()}`, hash: "#settings" };
  }
  search.set("agentSettings", diagnostic.correction.section ?? "model");
  return { pathname, search: `?${search.toString()}`, hash: "#settings" };
}
