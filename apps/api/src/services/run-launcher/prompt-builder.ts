// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate platform system prompt — thin shim over the runtime's
 * `buildPlatformPromptInputs` + `renderPlatformPrompt`. Derivation of
 * every section (System / Environment / Tools / Skills / Input /
 * Files / Config / Checkpoint / Memory / Output Format) happens in
 * the runtime from the parsed Bundle; this function only adds the
 * overrides that are platform-specific:
 *
 *   - `platformName`: `"Appstrate"`
 *   - `uploads`: DB-stored files with platform-sanitised paths
 *   - `workspaceTmpfsSizeMb`: the operator's workspace cap, when the
 *     backend actually mounts one (see `promptWorkspaceTmpfsSizeMb`)
 *   - `workspaceTmpfsSizePercent`: a backend-declared writable-root cap
 *   - `agentResources`: the effective allocation and semantics already
 *     resolved onto the run plan
 *
 *   - `availableIntegrationIds`: the integrations actually spawned for this
 *     run, which narrow the root manifest's declared integrations
 *
 * Every other field flows straight from the bundle — the same code
 * path used by the `appstrate run` CLI. Outbound API access is surfaced
 * via integration MCP tools (`{ns}__api_call`); the prompt only lists
 * each integration and where its INTEGRATION.md sits in the workspace.
 *
 * Run history is NOT rendered in the prompt: the runtime wires a
 * typed `run_history` tool (see runtime-pi/entrypoint.ts Phase D) whose
 * description self-documents the capability — the agent never sees the
 * sidecar URL.
 */

import type { AppstrateRunPlan } from "./types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import {
  buildPlatformPromptInputs,
  renderPlatformPrompt,
  UNAVAILABLE_INTEGRATION_REASONS,
} from "@appstrate/afps-runtime/bundle";
import { getEnv } from "@appstrate/env";
import { getExecutionMode, type ExecutionMode } from "../../infra/mode.ts";
import type { DroppedIntegration } from "../integration-spawn-resolver.ts";
import { orchestratorAppliesWorkspaceTmpfsCap } from "../orchestrator/index.ts";

/**
 * Workspace tmpfs cap (MB) to state in the prompt, or 0 to stay silent.
 *
 * `WORKSPACE_TMPFS_SIZE_MB` only configures a real mount on a backend that
 * declares `appliesWorkspaceTmpfsCap`. The process backend gives the run a
 * plain directory under `os.tmpdir()` without applying the setting, and a
 * module-contributed backend's workspace is opaque to core. The question is
 * asked of the orchestrator REGISTRY rather than by naming a backend id: the
 * registry is what a module-contributed backend can answer, and the microVM
 * equivalent of the same fact (`writableRootTmpfsPercent`, used 40 lines
 * below) already comes from there. Fail-closed — an undeclared backend stays
 * silent, because stating a cap the backend does not apply is misinformation.
 */
function promptWorkspaceTmpfsSizeMb(executionMode: ExecutionMode): number {
  return orchestratorAppliesWorkspaceTmpfsCap(executionMode) ? getEnv().WORKSPACE_TMPFS_SIZE_MB : 0;
}

export function buildPlatformSystemPrompt(
  context: ExecutionContext,
  plan: AppstrateRunPlan,
): string {
  const executionMode = getExecutionMode();
  // `./files/` — the ONE directory `runtime-pi/provision.ts` streams the run's
  // input files into. This announcement and that layout must stay
  // spelled the same: a divergence is a prompt-level miss, not an error — the
  // bytes are provisioned either way, the agent is simply pointed at a
  // directory that is not there and nothing reports a fault. It is kept true by
  // the env schema, which fails boot unless `PI_IMAGE` carries the platform's
  // own version, so the image reading this prompt lays files out as the
  // platform writing it does.
  const uploads = plan.files?.map((f) => ({
    name: f.name,
    path: `./files/${f.workspaceName}`,
    size: f.size,
    ...(f.type ? { type: f.type } : {}),
  }));

  // Only the integrations spawned for this run: a declared one that is
  // inactive or unbound is not spawned, and a dropped one is listed under
  // `unavailableIntegrations` instead. One id per integration, however many
  // connections it binds.
  const spawnedIds = new Set(plan.integrations?.map((spec) => spec.integrationId));
  const unavailableIntegrations = unavailableIntegrationsOf(plan.droppedIntegrations ?? []);

  const inputs = buildPlatformPromptInputs(plan.bundle, context, {
    platformName: "Appstrate",
    timeoutSeconds: plan.timeout,
    // The runtime knows the workspace is capped; without this the agent
    // does not, and a dependency install dies with ENOSPC mid-run.
    workspaceTmpfsSizeMb: promptWorkspaceTmpfsSizeMb(executionMode),
    workspaceTmpfsSizePercent: plan.resources.writableRootTmpfsPercent,
    ...(plan.resources.semantics
      ? {
          agentResources: {
            ...plan.resources.effective,
            semantics: plan.resources.semantics,
          },
        }
      : {}),
    // Deliverables convention: files the agent writes under
    // `./outputs/` are swept and published as durable run files at
    // finalize. Rendered as a platform-managed section BEFORE the raw prompt
    // (see renderPlatformPrompt) so the raw user prompt stays strictly last.
    deliverables: true,
    ...(uploads ? { uploads } : {}),
    availableIntegrationIds: spawnedIds,
    ...(unavailableIntegrations.length > 0 ? { unavailableIntegrations } : {}),
  });

  // The agent's tools — runtime-wired (`run_history`, `recall_memory`),
  // integration tools, and the platform runtime tools (output/log/note/
  // pin) — are all advertised to the model via MCP `tools/list`
  // (name + description + input schema), so the prompt does not list
  // them. The Communication contract (rendered above) is the only
  // tool-related instruction the model can't infer from `tools/list`, and
  // it stays. This keeps a single source of truth for each tool's
  // signature and avoids a stale/partial in-prompt list that would
  // contradict the live tool set.
  return renderPlatformPrompt(inputs);
}

/** One entry per integration id, its causes joined (a set drops one entry per connection). */
function unavailableIntegrationsOf(
  dropped: readonly DroppedIntegration[],
): Array<{ id: string; reason: string }> {
  const reasons = new Map<string, Set<string>>();
  for (const entry of dropped) {
    // As the agent reads it; the raw reason stays in the run log.
    const text = UNAVAILABLE_INTEGRATION_REASONS[entry.reason];
    const reason = entry.connectionLabel ? `connection '${entry.connectionLabel}': ${text}` : text;
    reasons.set(entry.integrationId, (reasons.get(entry.integrationId) ?? new Set()).add(reason));
  }
  return [...reasons].map(([id, set]) => ({ id, reason: [...set].join("; ") }));
}
