// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate platform system prompt — thin shim over the runtime's
 * `buildPlatformPromptInputs` + `renderPlatformPrompt`. Derivation of
 * every section (System / Environment / Tools / Skills / Input /
 * Documents / Config / Checkpoint / Memory / Output Format) happens in
 * the runtime from the parsed Bundle; this function only adds the
 * overrides that are platform-specific:
 *
 *   - `platformName`: `"Appstrate"`
 *   - `uploads`: DB-stored files with platform-sanitised paths
 *   - `workspaceTmpfsSizeMb`: the operator's workspace cap, when the
 *     backend actually mounts one (see `promptWorkspaceTmpfsSizeMb`)
 *   - `agentResources`: the effective allocation and semantics already
 *     resolved onto the run plan
 *
 * Every other field flows straight from the bundle — the same code
 * path used by the `appstrate run` CLI. Outbound API access is surfaced
 * via integration MCP tools (`{ns}__api_call`), not the prompt.
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
  type PlatformPromptIntegration,
} from "@appstrate/afps-runtime/bundle";
import { getEnv } from "@appstrate/env";
import { getExecutionMode } from "../../infra/mode.ts";
import { fetchIntegrationPromptDocs } from "../integration-service.ts";

/**
 * Workspace tmpfs cap (MB) to state in the prompt, or 0 to stay silent.
 *
 * `WORKSPACE_TMPFS_SIZE_MB` configures a real mount only on the docker
 * backend (docker-orchestrator.ts, `createIsolationBoundary`). The
 * process backend gives the run a plain directory under `os.tmpdir()`
 * without applying this setting, and a module-contributed backend's
 * workspace is opaque to core. Fail closed on anything but docker:
 * stating a cap that the selected backend does not use would be misleading.
 */
function promptWorkspaceTmpfsSizeMb(): number {
  return getExecutionMode() === "docker" ? getEnv().WORKSPACE_TMPFS_SIZE_MB : 0;
}

export async function buildPlatformSystemPrompt(
  context: ExecutionContext,
  plan: AppstrateRunPlan,
): Promise<string> {
  const uploads = plan.files?.map((f) => ({
    name: f.name,
    path: `./documents/${f.workspaceName}`,
    size: f.size,
    ...(f.type ? { type: f.type } : {}),
  }));

  // Phase 1.4 — inline each resolved integration's manifest description +
  // INTEGRATION.md (AFPS §3.5) so the LLM can read the integration's
  // API contract alongside the `{ns}__*` tools advertised via MCP
  // `tools/list`. Docs are pulled from `packages.draftContent` (captured
  // at install time by `core/zip.ts`) — never re-fetched from storage.
  let integrations: PlatformPromptIntegration[] | undefined;
  if (plan.integrations && plan.integrations.length > 0) {
    const docs = await fetchIntegrationPromptDocs(plan.integrations.map((i) => i.integrationId));
    const docsById = new Map(docs.map((d) => [d.packageId, d]));
    integrations = plan.integrations.map((spec) => {
      const found = docsById.get(spec.integrationId);
      return {
        id: spec.integrationId,
        ...(found?.description ? { description: found.description } : {}),
        ...(found?.doc ? { doc: found.doc } : {}),
      };
    });
  }

  const inputs = buildPlatformPromptInputs(plan.bundle, context, {
    platformName: "Appstrate",
    timeoutSeconds: plan.timeout,
    // The runtime knows the workspace is capped; without this the agent
    // does not, and a dependency install dies with ENOSPC mid-run (#1019).
    workspaceTmpfsSizeMb: promptWorkspaceTmpfsSizeMb(),
    ...(plan.resources.semantics
      ? {
          agentResources: {
            ...plan.resources.effective,
            semantics: plan.resources.semantics,
          },
        }
      : {}),
    // Deliverables convention (Phase 2): files the agent writes under
    // `./outputs/` are swept and published as durable run documents at
    // finalize. Rendered as a platform-managed section BEFORE the raw prompt
    // (see renderPlatformPrompt) so the raw user prompt stays strictly last.
    deliverables: true,
    ...(uploads ? { uploads } : {}),
    ...(integrations && integrations.length > 0 ? { integrations } : {}),
  });

  // The agent's tools — runtime-wired (`run_history`, `recall_memory`),
  // integration tools, and the platform runtime tools (output/log/note/
  // pin) — are all advertised to the model via MCP `tools/list`
  // (name + description + input schema), so the prompt no longer lists
  // them. The Communication contract (rendered above) is the only
  // tool-related instruction the model can't infer from `tools/list`, and
  // it stays. This keeps a single source of truth for each tool's
  // signature and avoids a stale/partial in-prompt list that would
  // contradict the live tool set.
  return renderPlatformPrompt(inputs);
}
