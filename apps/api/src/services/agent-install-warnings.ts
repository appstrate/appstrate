// SPDX-License-Identifier: Apache-2.0

import { AGENT_RESOURCES_META_KEY, getAgentResourceHints } from "@appstrate/core/validation";
import type { OrchestratorAgentResourceCapabilities } from "@appstrate/core/platform-types";
import { getExecutionMode } from "../infra/mode.ts";
import { orchestratorAgentResources } from "./orchestrator/registry.ts";
import {
  getPlatformRunLimits,
  resolveAgentResources,
  resolveRunTimeout,
  type AgentResourcePolicy,
  type RunTimeoutPolicy,
} from "./run-limits.ts";

/**
 * Install-time warnings for `agent` manifests that declare something the
 * platform will silently narrow at run time.
 *
 * Sibling of `integration-install-warnings.ts` (same non-blocking `warnings`
 * channel on the import 201). The public collector reads deployment policy;
 * the resource rule remains pure so operator and backend ceilings can be
 * tested without mutating process-wide state.
 *
 * Deliberately warnings, never rejections: deployment-specific ceilings do not
 * make an otherwise portable package invalid.
 */
function asAgentManifest(manifest: unknown): Record<string, unknown> | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const m = manifest as Record<string, unknown>;
  return m.type === "agent" ? m : undefined;
}

function collectTimeoutWarnings(
  manifest: Record<string, unknown>,
  policy: RunTimeoutPolicy,
): string[] {
  const { declaredSeconds, effectiveSeconds, capped } = resolveRunTimeout(manifest.timeout, policy);
  if (!capped) return [];

  return [
    `timeout: declared ${declaredSeconds}s exceeds this deployment's ceiling — runs will be capped at ${effectiveSeconds}s.`,
  ];
}

/** Pure resource-warning rule for an already-validated manifest. */
export function collectAgentResourceWarnings(
  manifest: unknown,
  policy: AgentResourcePolicy,
  backendCapabilities: OrchestratorAgentResourceCapabilities | undefined,
): string[] {
  const agent = asAgentManifest(manifest);
  if (!agent) return [];

  // Throws on malformed stored data: import validation must run before this
  // collector, and bypassing that boundary is corruption, not a warning.
  const hints = getAgentResourceHints(
    agent as { readonly _meta?: Readonly<Record<string, unknown>> },
  );
  if (!hints || !backendCapabilities) return [];

  const resolved = resolveAgentResources(hints, policy, backendCapabilities);
  const path = `_meta[${JSON.stringify(AGENT_RESOURCES_META_KEY)}]`;
  const warnings: string[] = [];

  if (hints.memoryMb !== undefined && resolved.memoryCapped) {
    warnings.push(
      `${path}.memory_mb: declared ${hints.memoryMb} MiB exceeds this deployment's effective ceiling — runs will use ${resolved.effective.memoryMb} MiB.`,
    );
  }
  if (hints.cpu !== undefined && resolved.cpuCapped) {
    warnings.push(
      `${path}.cpu: declared ${hints.cpu} vCPU exceeds this deployment's effective ceiling — runs will use ${resolved.effective.cpu} vCPU.`,
    );
  }

  return warnings;
}

export function collectAgentInstallWarnings(manifest: unknown): string[] {
  const agent = asAgentManifest(manifest);
  if (!agent) return [];

  const policy = getPlatformRunLimits();
  const executionMode = getExecutionMode();
  const backendCapabilities = orchestratorAgentResources(executionMode);

  return [
    ...collectTimeoutWarnings(agent, policy),
    ...collectAgentResourceWarnings(agent, policy, backendCapabilities),
  ];
}
