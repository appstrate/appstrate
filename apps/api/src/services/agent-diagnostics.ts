// SPDX-License-Identifier: Apache-2.0

/**
 * Agent diagnostics are an application capability, not a property of the map.
 *
 * The run readiness gate remains authoritative for blocking bundle, dependency,
 * integration and configuration checks. This service enriches those errors
 * with stable routing metadata so Overview, the header and the future rich map
 * can consume the same result without each rebuilding readiness rules.
 */

import { asJSONSchemaObject, mergeWithDefaults } from "@appstrate/core/form";
import type { LoadedPackage } from "../types/index.ts";
import type { Actor } from "../lib/actor.ts";
import type { AppScope } from "../lib/scope.ts";
import type { ValidationFieldError } from "../lib/errors.ts";
import { getPackageConfig } from "./application-packages.ts";
import { collectAgentReadinessErrors } from "./agent-readiness.ts";
import { resolveAgentRunVersion, VERSION_SELECTOR_DRAFT } from "./agent-version-resolver.ts";
import { resolveAgentConnectionReadiness } from "./integration-pins-service.ts";
import { resolveModel } from "./org-models.ts";
import { listPackageSchedules } from "./scheduler.ts";

export type AgentDiagnosticSeverity = "blocking" | "warning";
export type AgentDiagnosticNode = "agent" | "config" | "skills" | "toolbox" | "model" | "schedules";
export type AgentDiagnosticDestination = "bundle" | "configuration" | "schedule";

export interface AgentDiagnostic {
  code: string;
  severity: AgentDiagnosticSeverity;
  title: string;
  explanation: string;
  field: string;
  target: {
    node: AgentDiagnosticNode | null;
    item: string | null;
  };
  correction: {
    destination: AgentDiagnosticDestination;
    section: string | null;
    params: Record<string, string>;
  };
  /** A launch can open the existing connection recovery flow for this issue. */
  recoverable_on_launch: boolean;
}

/**
 * Contract for the future rich Map consumer:
 *
 * - `target.node` selects the semantic ReactFlow node, independently of its
 *   current coordinates or component implementation;
 * - `target.item` selects a row inside that node when one exists;
 * - `severity` drives the orange warning or red blocking marker;
 * - `?agentIssue=<code>#map` asks the map to reveal and center the matching
 *   target, while `?agentDiagnostics=all#map` opens its diagnostic mode;
 * - `correction` is the owner-surface link and must not be reconstructed from
 *   node ids in the renderer.
 */

export interface AgentDiagnosticsResult {
  status: "healthy" | "warning" | "blocking";
  blocking_count: number;
  warning_count: number;
  /** False only when a blocker cannot be resolved by the launch recovery flow. */
  can_launch: boolean;
  diagnostics: AgentDiagnostic[];
}

const CONNECTION_CODES = new Set([
  "not_connected",
  "needs_reconnection",
  "pinned_connection_unavailable",
  "override_connection_unavailable",
  "must_choose_connection",
  "insufficient_scopes",
  "auth_key_mismatch",
]);

function routeError(error: ValidationFieldError): Omit<AgentDiagnostic, "severity"> {
  const configKey = error.field.match(/^config\.(.+)$/)?.[1] ?? null;
  const skillId = error.field.match(/^dependencies\.skills\.(.+)$/)?.[1] ?? null;
  const integrationId = error.field.match(/^integrations\.(.+)$/)?.[1] ?? null;
  const connectionIssue = CONNECTION_CODES.has(error.code);

  if (error.field === "prompt") {
    return {
      code: error.code,
      title: error.title ?? "Bundle issue",
      explanation: error.message,
      field: error.field,
      target: { node: "agent", item: null },
      correction: { destination: "bundle", section: "prompt", params: {} },
      recoverable_on_launch: false,
    };
  }
  if (skillId) {
    return {
      code: error.code,
      title: error.title ?? "Skill unavailable",
      explanation: error.message,
      field: error.field,
      target: { node: "skills", item: skillId },
      correction: { destination: "bundle", section: "skills", params: { skill: skillId } },
      recoverable_on_launch: false,
    };
  }
  if (integrationId) {
    const section =
      connectionIssue || error.code === "integration_not_active" ? "connections" : "integrations";
    return {
      code: error.code,
      title: error.title ?? "Integration unavailable",
      explanation: error.message,
      field: error.field,
      target: { node: "toolbox", item: integrationId },
      correction: {
        destination: section === "connections" ? "configuration" : "bundle",
        section,
        params: { integration: integrationId },
      },
      recoverable_on_launch: connectionIssue,
    };
  }
  return {
    code: error.code,
    title: error.title ?? "Configuration issue",
    explanation: error.message,
    field: error.field,
    target: { node: "config", item: configKey },
    correction: {
      destination: "configuration",
      section: "inputs",
      params: configKey ? { field: configKey } : {},
    },
    recoverable_on_launch: false,
  };
}

export async function getAgentDiagnostics(args: {
  scope: AppScope;
  agent: LoadedPackage;
  actor: Actor;
  isAdmin: boolean;
  version?: string;
}): Promise<AgentDiagnosticsResult> {
  const { scope, actor, isAdmin } = args;
  const versionRef = args.version?.trim() || VERSION_SELECTOR_DRAFT;
  const { agent } = await resolveAgentRunVersion(args.agent, versionRef);
  const packageConfig = await getPackageConfig(scope.applicationId, agent.id);
  const configSchema = asJSONSchemaObject(
    agent.manifest.config?.schema ?? { type: "object", properties: {} },
  );
  const effectiveConfig = mergeWithDefaults(configSchema, packageConfig.config);

  // Connections are resolved once through their dedicated bulk service. The
  // core readiness pass therefore runs without an actor to avoid duplicating
  // that query and producing duplicate diagnostics.
  const [readinessErrors, connections, model, schedules] = await Promise.all([
    collectAgentReadinessErrors({
      agent,
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      actor: null,
      config: effectiveConfig,
    }),
    resolveAgentConnectionReadiness({
      scope,
      agentPackageId: agent.id,
      actor,
      isAdmin,
      version: versionRef,
    }),
    resolveModel(scope.orgId, agent.id, packageConfig.modelId),
    listPackageSchedules(scope, agent.id, actor),
  ]);

  const readinessFields = new Set(readinessErrors.map((error) => error.field));
  const connectionErrors = connections.errors.filter((error) => !readinessFields.has(error.field));
  const blocking: AgentDiagnostic[] = [...readinessErrors, ...connectionErrors].map((error) => ({
    ...routeError(error),
    severity: "blocking",
  }));

  if (!model) {
    blocking.push({
      code: "missing_model",
      severity: "blocking",
      title: "Model not configured",
      explanation: "No usable model is configured for this agent or organization.",
      field: "model",
      target: { node: "model", item: null },
      correction: { destination: "configuration", section: "model", params: {} },
      recoverable_on_launch: false,
    });
  }

  const warnings: AgentDiagnostic[] = schedules
    .filter(
      (schedule) =>
        schedule.enabled &&
        Boolean(schedule.version_override) &&
        schedule.version_override !== versionRef,
    )
    .map((schedule) => ({
      code: "schedule_version_differs",
      severity: "warning" as const,
      title: "Schedule uses another version",
      explanation: `Schedule '${schedule.name ?? schedule.id}' is pinned to '${schedule.version_override}' while this view inspects '${versionRef}'.`,
      field: `schedules.${schedule.id}.version`,
      target: { node: "schedules" as const, item: schedule.id },
      correction: {
        destination: "schedule" as const,
        section: "version",
        params: { scheduleId: schedule.id },
      },
      recoverable_on_launch: false,
    }));

  const diagnostics = [...blocking, ...warnings];
  return {
    status: blocking.length > 0 ? "blocking" : warnings.length > 0 ? "warning" : "healthy",
    blocking_count: blocking.length,
    warning_count: warnings.length,
    can_launch: blocking.every((diagnostic) => diagnostic.recoverable_on_launch),
    diagnostics,
  };
}
