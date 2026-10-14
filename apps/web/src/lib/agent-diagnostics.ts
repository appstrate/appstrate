// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical Agent diagnostics routing.
 *
 * The backend owns every verdict and correction. This module only words that
 * interface and maps it to SPA locations. It must never infer whether something
 * is healthy or invent a fix.
 */

import type {
  INTEGRATION_MANIFEST_FAILURE_CODES,
  ReadinessErrorCode,
} from "@appstrate/core/integration";
import type { AgentDiagnostic } from "../hooks/use-agent-diagnostics";

/** Every code the diagnostics carry: readiness, connection and model verdicts, and warnings. */
type AgentDiagnosticCode =
  | ReadinessErrorCode
  | (typeof INTEGRATION_MANIFEST_FAILURE_CODES)[number]
  | "empty_prompt"
  | "missing_skill"
  | "model_not_configured"
  | "model_credential_required"
  | "pinned_model_unavailable"
  | "schedule_version_differs";

const DIAGNOSTIC_TEXT_KEYS = {
  empty_prompt: {
    title: "detail.diagnostics.emptyPrompt.title",
    explanation: "detail.diagnostics.emptyPrompt.explanation",
  },
  missing_skill: {
    title: "detail.diagnostics.missingSkill.title",
    explanation: "detail.diagnostics.missingSkill.explanation",
  },
  integration_not_found: {
    title: "detail.diagnostics.integrationNotFound.title",
    explanation: "detail.diagnostics.integrationNotFound.explanation",
  },
  integration_wrong_type: {
    title: "detail.diagnostics.integrationWrongType.title",
    explanation: "detail.diagnostics.integrationWrongType.explanation",
  },
  integration_invalid_manifest: {
    title: "detail.diagnostics.integrationInvalidManifest.title",
    explanation: "detail.diagnostics.integrationInvalidManifest.explanation",
  },
  not_connected: {
    title: "detail.diagnostics.notConnected.title",
    explanation: "detail.diagnostics.notConnected.explanation",
  },
  needs_reconnection: {
    title: "detail.diagnostics.needsReconnection.title",
    explanation: "detail.diagnostics.needsReconnection.explanation",
  },
  pinned_connection_unavailable: {
    title: "detail.diagnostics.pinnedConnectionUnavailable.title",
    explanation: "detail.diagnostics.pinnedConnectionUnavailable.explanation",
  },
  override_connection_unavailable: {
    title: "detail.diagnostics.overrideConnectionUnavailable.title",
    explanation: "detail.diagnostics.overrideConnectionUnavailable.explanation",
  },
  override_outranked: {
    title: "detail.diagnostics.overrideOutranked.title",
    explanation: "detail.diagnostics.overrideOutranked.explanation",
  },
  must_choose_connection: {
    title: "detail.diagnostics.mustChooseConnection.title",
    explanation: "detail.diagnostics.mustChooseConnection.explanation",
  },
  insufficient_scopes: {
    title: "detail.diagnostics.insufficientScopes.title",
    explanation: "detail.diagnostics.insufficientScopes.explanation",
  },
  auth_key_mismatch: {
    title: "detail.diagnostics.authKeyMismatch.title",
    explanation: "detail.diagnostics.authKeyMismatch.explanation",
  },
  auth_serves_no_selected_tool: {
    title: "detail.diagnostics.authServesNoSelectedTool.title",
    explanation: "detail.diagnostics.authServesNoSelectedTool.explanation",
  },
  auth_key_serves_no_selected_tool: {
    title: "detail.diagnostics.authKeyServesNoSelectedTool.title",
    explanation: "detail.diagnostics.authKeyServesNoSelectedTool.explanation",
  },
  required_integration_unbound: {
    title: "detail.diagnostics.requiredIntegrationUnbound.title",
    explanation: "detail.diagnostics.requiredIntegrationUnbound.explanation",
  },
  integration_not_active: {
    title: "detail.diagnostics.integrationNotActive.title",
    explanation: "detail.diagnostics.integrationNotActive.explanation",
  },
  agent_not_active: {
    title: "detail.diagnostics.agentNotActive.title",
    explanation: "detail.diagnostics.agentNotActive.explanation",
  },
  model_not_configured: {
    title: "detail.diagnostics.modelNotConfigured.title",
    explanation: "detail.diagnostics.modelNotConfigured.explanation",
  },
  model_credential_required: {
    title: "detail.diagnostics.modelCredentialRequired.title",
    explanation: "detail.diagnostics.modelCredentialRequired.explanation",
  },
  pinned_model_unavailable: {
    title: "detail.diagnostics.pinnedModelUnavailable.title",
    explanation: "detail.diagnostics.pinnedModelUnavailable.explanation",
  },
  schedule_version_differs: {
    title: "detail.diagnostics.scheduleVersionDiffers.title",
    explanation: "detail.diagnostics.scheduleVersionDiffers.explanation",
  },
} as const satisfies Record<AgentDiagnosticCode, { title: string; explanation: string }>;

/**
 * What a diagnostic says, in the reader's language: worded by `code`, its
 * values read from `correction.params`. The server's English text is kept only
 * for a code this bundle does not know yet.
 */
export function agentDiagnosticText(
  diagnostic: AgentDiagnostic,
  t: (key: string, options?: Record<string, unknown>) => string,
): { title: string; explanation: string } {
  if (!Object.prototype.hasOwnProperty.call(DIAGNOSTIC_TEXT_KEYS, diagnostic.code)) {
    return { title: diagnostic.title, explanation: diagnostic.explanation };
  }
  const keys = DIAGNOSTIC_TEXT_KEYS[diagnostic.code as AgentDiagnosticCode];
  const { params } = diagnostic.correction;
  const version = (value: string | undefined) =>
    value === "draft" ? t("detail.diagnostics.draftVersion") : value;
  const values = {
    ...params,
    schedule_version: version(params.schedule_version),
    inspected_version: version(params.inspected_version),
  };
  return { title: t(keys.title, values), explanation: t(keys.explanation, values) };
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
