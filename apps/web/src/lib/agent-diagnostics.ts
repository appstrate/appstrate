// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical Agent diagnostics routing.
 *
 * The backend owns every verdict, correction and semantic target. This module
 * only adapts that interface to SPA locations and the current React Flow node
 * ids. It must never infer whether something is healthy or invent a fix from a
 * visual card id.
 */

import type { AgentDiagnostic } from "../hooks/use-agent-diagnostics";

export const AGENT_DIAGNOSTIC_QUERY_KEYS = ["agentDiagnostics", "agentIssue", "agentIssueField"];

const MAP_NODE_BY_TARGET: Record<NonNullable<AgentDiagnostic["target"]["node"]>, string> = {
  agent: "agent",
  config: "input_values",
  skills: "skills",
  toolbox: "toolbox",
  model: "model",
  schedules: "schedules",
};

export function agentDiagnosticKey(diagnostic: AgentDiagnostic): string {
  return `${diagnostic.code}:${diagnostic.field}`;
}

/** Translate a semantic backend target to the current drawing only. */
export function agentDiagnosticMapNodeId(diagnostic: AgentDiagnostic): string | null {
  const target = diagnostic.target.node;
  return target ? MAP_NODE_BY_TARGET[target] : null;
}

export function requestedAgentDiagnostic(
  search: URLSearchParams,
  diagnostics: AgentDiagnostic[],
): AgentDiagnostic | null {
  const requestedField = search.get("agentIssueField");
  if (requestedField) {
    const exact = diagnostics.find((diagnostic) => diagnostic.field === requestedField);
    if (exact) return exact;
  }
  const requestedCode = search.get("agentIssue");
  return diagnostics.find((diagnostic) => diagnostic.code === requestedCode) ?? null;
}

export function agentDiagnosticLocateTarget(
  diagnostic: AgentDiagnostic,
  pathname: string,
  currentSearch: string,
) {
  const search = new URLSearchParams(currentSearch);
  search.delete("agentDiagnostics");
  search.set("agentIssue", diagnostic.code);
  // A code may occur more than once, for example one warning per schedule.
  // The field keeps a copied support URL deterministic without changing the
  // public meaning of `agentIssue`.
  search.set("agentIssueField", diagnostic.field);
  search.set("agentSettings", "map");
  return { pathname, search: `?${search.toString()}`, hash: "#settings" };
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
  for (const key of AGENT_DIAGNOSTIC_QUERY_KEYS) search.delete(key);
  if (diagnostic.correction.destination === "bundle") {
    search.set("agentBundle", diagnostic.correction.section ?? "general");
    search.set("agentSettings", "files");
    return { pathname, search: `?${search.toString()}`, hash: "#settings" };
  }
  search.set("agentSettings", diagnostic.correction.section ?? "model");
  return { pathname, search: `?${search.toString()}`, hash: "#settings" };
}
