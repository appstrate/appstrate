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
 *
 * Every other field flows straight from the bundle — the same code
 * path used by the `appstrate run` CLI. Divergence between platform
 * and CLI is now strictly the two overrides above. Outbound API access
 * is surfaced via integration MCP tools (`{ns}__api_call`), not the
 * prompt.
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
import { sanitizeStorageKey } from "../file-storage.ts";
import { fetchIntegrationPromptDocs } from "../integration-service.ts";

export async function buildPlatformSystemPrompt(
  context: ExecutionContext,
  plan: AppstrateRunPlan,
): Promise<string> {
  const uploads = plan.files?.map((f) => ({
    name: f.name,
    path: `./documents/${sanitizeStorageKey(f.name)}`,
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
    ...(uploads ? { uploads } : {}),
    ...(integrations && integrations.length > 0 ? { integrations } : {}),
  });

  // The agent's tools — runtime-wired (`run_history`, `recall_memory`),
  // integration tools, and the platform runtime tools (output/log/note/
  // pin/report) — are all advertised to the model via MCP `tools/list`
  // (name + description + input schema), so the prompt no longer lists
  // them. The Communication contract (rendered above) is the only
  // tool-related instruction the model can't infer from `tools/list`, and
  // it stays. This keeps a single source of truth for each tool's
  // signature and avoids a stale/partial in-prompt list that would
  // contradict the live tool set.
  // Deliverables convention (Phase 2): files the agent writes under
  // `./outputs/` are published automatically as durable run documents at the
  // end of the run — one concise line so the agent knows where to put anything
  // it produces for the user. (The optional `publish_document` tool covers
  // deliverables written elsewhere.)
  return `${renderPlatformPrompt(inputs)}

## Deliverables

Write any file you produce for the user (reports, exports, generated documents) under \`./outputs/\` — everything there is published automatically as a downloadable document when the run ends.`;
}
