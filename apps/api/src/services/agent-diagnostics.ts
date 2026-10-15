// SPDX-License-Identifier: Apache-2.0

/**
 * Agent diagnostics are an application capability, not a property of the map.
 *
 * The run readiness gate remains authoritative for blocking bundle, dependency,
 * integration and configuration checks. This service enriches those errors
 * with their correction destination and the map node they point at, so
 * Overview, the header and the agent map consume the same result without each
 * rebuilding readiness rules.
 */

import {
  CONNECTION_RESOLUTION_ERROR_REMEDY,
  type ConnectionResolutionErrorCode,
} from "@appstrate/core/integration";
import type { LoadedPackage } from "../types/index.ts";
import type { ConnectionPrincipal } from "../lib/connection-principal.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { ApiError, type ValidationFieldError } from "../lib/errors.ts";
import { getSpacePackageSettings, isPackageActiveHere } from "./space-packages.ts";
import { collectBundleReadinessErrors } from "./agent-readiness.ts";
import {
  VERSION_SELECTOR_PUBLISHED,
  resolveAgentRunVersion,
  resolveVersionRefs,
  versionRefOf,
} from "./agent-version-resolver.ts";
import {
  agentNotActiveError,
  resolveDefinitionConnectionReadiness,
} from "./integration-pins-service.ts";
import {
  requireBoundModel,
  resolveModelCascade,
  type BoundModel,
  type ResolvedModel,
} from "./org-models.ts";
import { ModelCredentialMissingError, modelCredentialIsPresent } from "./run-context-builder.ts";
import { listPackageScheduleRows } from "./scheduler.ts";

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
  diagnostics: AgentDiagnostic[];
}

/** A resolver code cleared on the connections page rather than in the agent's bundle. */
function isConnectionRemedied(code: string): boolean {
  return (
    Object.hasOwn(CONNECTION_RESOLUTION_ERROR_REMEDY, code) &&
    CONNECTION_RESOLUTION_ERROR_REMEDY[code as ConnectionResolutionErrorCode] === "connection"
  );
}

/** Where a readiness error is corrected. */
export function routeError(error: ValidationFieldError): Omit<AgentDiagnostic, "severity"> {
  const configKey = error.field.match(/^config\.(.+)$/)?.[1] ?? null;
  const skillId = error.field.match(/^dependencies\.skills\.(.+)$/)?.[1] ?? null;
  const integrationId = error.field.match(/^integrations\.(.+)$/)?.[1] ?? null;

  if (error.field === "prompt") {
    return {
      code: error.code,
      title: error.title ?? "Bundle issue",
      explanation: error.message,
      field: error.field,
      target: { node: "agent", item: null },
      correction: { destination: "bundle", section: "prompt", params: {} },
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
    };
  }
  if (integrationId) {
    const section = isConnectionRemedied(error.code) ? "connections" : "integrations";
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
    };
  }
  if (error.field === "agent") {
    return {
      code: error.code,
      title: error.title ?? "Agent not active",
      explanation: error.message,
      field: error.field,
      target: { node: "agent", item: null },
      correction: { destination: "configuration", section: "activation", params: {} },
    };
  }
  return {
    code: error.code,
    title: error.title ?? "Configuration issue",
    explanation: error.message,
    field: error.field,
    target: { node: "config", item: configKey },
    correction: { destination: "configuration", section: null, params: {} },
  };
}

/**
 * The launch's refusal of its resolved model, under the launch's code, else
 * `null`: none resolved, no credential of the payer serves it, or its
 * credential carries no secret.
 */
function modelRefusal(
  model: ResolvedModel | null,
  payerUserId: string | null,
): { code: string; title: string; message: string } | null {
  if (!model) {
    return {
      code: "model_not_configured",
      title: "Model not configured",
      message: "No usable model is configured for this agent or organization.",
    };
  }
  let bound: BoundModel;
  try {
    bound = requireBoundModel(model, payerUserId);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return { code: err.code, title: "Model credential required", message: err.message };
  }
  if (modelCredentialIsPresent(bound)) return null;
  return {
    code: "model_credential_missing",
    title: "Model credential missing",
    message: new ModelCredentialMissingError(bound.label).message,
  };
}

export async function getAgentDiagnostics(args: {
  scope: SpaceScope;
  agent: LoadedPackage;
  /** Who acts on connections, decided at the door (`connectionPrincipal(c)`). */
  principal: ConnectionPrincipal;
  /** The connect routes' own guards, so a diagnostic cannot promise what they refuse. */
  canConnect: boolean;
  canConfigureIntegrations: boolean;
  /** Who would pay the model of a launch: `requestPayerUserId(c)`, computed at the door. */
  payerUserId: string | null;
  /**
   * The definition judged, decided by the router exactly as for the detail page:
   * an explicit selector (`draft` only for a caller who may write the agent),
   * else `defaultDefinitionSelector`.
   */
  version: string;
  /** Connection verdicts are reported only to a caller holding `integrations:read`. */
  canReadIntegrations: boolean;
  /** Schedules are reported only to a caller holding `schedules:read`. */
  canReadSchedules: boolean;
}): Promise<AgentDiagnosticsResult> {
  const { scope, principal, canConnect, canConfigureIntegrations, payerUserId } = args;
  const { agent, overrideVersionLabel } = await resolveAgentRunVersion(args.agent, args.version);
  const inspectedRef = versionRefOf(overrideVersionLabel);
  const packageConfig = await getSpacePackageSettings(scope, agent.id);

  // Connections are reported by their dedicated bulk service, so the bundle
  // pass leaves them out instead of resolving them twice.
  const [active, readinessErrors, connections, modelCascade, schedules] = await Promise.all([
    isPackageActiveHere(scope, agent.id),
    collectBundleReadinessErrors({ agent, orgId: scope.orgId, spaceId: scope.spaceId }),
    args.canReadIntegrations
      ? resolveDefinitionConnectionReadiness({
          scope,
          agent,
          principal,
          canConnect,
          canConfigureIntegrations,
        })
      : null,
    resolveModelCascade(scope.orgId, agent.id, packageConfig.modelId, payerUserId),
    // A system agent runs one definition whatever a schedule selects.
    args.canReadSchedules && agent.source !== "system"
      ? listPackageScheduleRows(scope, agent.id)
      : [],
  ]);

  const readinessFields = new Set(readinessErrors.map((error) => error.field));
  const connectionErrors = (connections?.errors ?? []).filter(
    (error) => !readinessFields.has(error.field),
  );
  // The activation verdict is the run doors' own, whatever the caller may read
  // of the connections: a switched-off agent is refused at launch either way.
  const blocking: AgentDiagnostic[] = [
    ...(active ? [] : [agentNotActiveError(agent.id)]),
    ...readinessErrors,
    ...connectionErrors,
  ].map((error) => ({ ...routeError(error), severity: "blocking" }));

  const refusal = modelRefusal(modelCascade?.model ?? null, payerUserId);
  if (refusal) {
    blocking.push({
      code: refusal.code,
      severity: "blocking",
      title: refusal.title,
      explanation: refusal.message,
      field: "model",
      target: { node: "model", item: null },
      correction: {
        destination: "configuration",
        section: "model",
        params: modelCascade ? { model: modelCascade.model.label } : {},
      },
    });
  }

  const warnings: AgentDiagnostic[] = [];

  // The same cascade and the same test as the launch (`buildRunContext`'s
  // `unavailablePinnedModelId`), so this warning and the run's `model_fallback`
  // marker cannot disagree: a pin that does not load is replaced by the default.
  if (modelCascade && packageConfig.modelId && !modelCascade.fromExplicit) {
    const fallback = modelCascade.model.label;
    warnings.push({
      code: "pinned_model_unavailable",
      severity: "warning",
      title: "Model unavailable",
      explanation: `The model set for this agent ('${packageConfig.modelId}') is no longer usable; the next run uses the default model '${fallback}' instead.`,
      field: "model",
      target: { node: "model", item: null },
      correction: {
        destination: "configuration",
        section: "model",
        params: { default_model: fallback },
      },
    });
  }

  // Compared as the versions each would run: an unpinned schedule runs the
  // latest published version, and `1.2.0` and `published` may name the same one.
  const enabledSchedules = schedules.filter((schedule) => schedule.enabled);
  const scheduleRefs = await resolveVersionRefs(
    agent.id,
    enabledSchedules.map((schedule) => schedule.version_override),
  );
  for (const [i, schedule] of enabledSchedules.entries()) {
    const ref = scheduleRefs[i] ?? null;
    if (ref === inspectedRef) continue;
    const name = schedule.name ?? schedule.id;
    const runs = ref ?? schedule.version_override ?? VERSION_SELECTOR_PUBLISHED;
    warnings.push({
      code: "schedule_version_differs",
      severity: "warning",
      title: "Schedule runs another version",
      explanation: `Schedule '${name}' runs version '${runs}' while this view inspects '${inspectedRef}'.`,
      field: `schedules.${schedule.id}.version`,
      target: { node: "schedules", item: schedule.id },
      correction: {
        destination: "schedule",
        section: "version",
        params: {
          scheduleId: schedule.id,
          schedule: name,
          schedule_version: runs,
          inspected_version: inspectedRef,
        },
      },
    });
  }

  const diagnostics = [...blocking, ...warnings];
  return {
    status: blocking.length > 0 ? "blocking" : warnings.length > 0 ? "warning" : "healthy",
    blocking_count: blocking.length,
    warning_count: warnings.length,
    diagnostics,
  };
}
