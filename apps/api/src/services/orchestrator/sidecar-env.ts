// SPDX-License-Identifier: Apache-2.0

/**
 * Spec-driven sidecar env assignments shared by both orchestrators
 * (docker + process). Covers ONLY the env vars derived from the
 * `SidecarLaunchSpec` whose semantics are identical across topologies.
 *
 * Deliberately NOT covered here (orchestrator-local, semantics differ):
 *   - base-env construction (`pickOperatorSidecarEnv` vs `cleanProcessEnv`)
 *   - `PORT`, `RUN_ID`, `PLATFORM_API_URL`, `WORKSPACE_HANDLE_JSON`
 *   - `INTEGRATION_RUNTIME_ADAPTER` — docker unconditionally overrides,
 *     process conditionally falls back; moving it would change behavior.
 */

import type { SidecarLaunchSpec } from "@appstrate/core/sidecar-types";

/**
 * Apply the spec→env assignments common to both orchestrators onto
 * `target`. Mutates `target` in place (the orchestrators build their
 * base env first, then layer these on).
 */
export function applySpecToSidecarEnv(
  spec: SidecarLaunchSpec,
  target: Record<string, string>,
): void {
  if (spec.proxyUrl) target.PROXY_URL = spec.proxyUrl;
  if (spec.modelContextWindow != null) {
    target.MODEL_CONTEXT_WINDOW = String(spec.modelContextWindow);
  }
  if (spec.modelMaxTokens != null) {
    target.MODEL_MAX_TOKENS = String(spec.modelMaxTokens);
  }
  if (spec.llm) {
    if (spec.llm.authMode === "oauth" || spec.llm.authMode === "vend") {
      // OAuth config (non-forging — the driver signs its own fingerprint) OR
      // vend config (the Codex CLI, token handed over via /credential-vend):
      // ship the full LlmProxyConfig as JSON so server.ts parses it into
      // config.llm at boot. Without this, /llm/* returns 503 and the vend
      // endpoint 403s "not enabled for this run". The vend config's required
      // `egressAllowlist` rides inside this JSON — no separate env var, so the
      // forward proxy's egress lock can never drift from its vend credential.
      target.PI_LLM_OAUTH_CONFIG_JSON = JSON.stringify(spec.llm);
    } else {
      target.PI_BASE_URL = spec.llm.baseUrl;
      target.PI_API_KEY = spec.llm.apiKey;
      target.PI_PLACEHOLDER = spec.llm.placeholder;
      // Model-alias swap (api-key path) — the real backing id rides
      // platform→sidecar only, never into the agent container. The OAuth path
      // carries it inside PI_LLM_OAUTH_CONFIG_JSON above.
      if (spec.llm.modelSwap) {
        target.PI_MODEL_SWAP_JSON = JSON.stringify(spec.llm.modelSwap);
      }
    }
  }
  // Phase 1.4 — integrations the sidecar will spawn + multiplex onto
  // the agent's MCP surface. Each entry carries the bundle bytes +
  // resolved spawn env (with live OAuth tokens / API keys).
  if (spec.integrations && spec.integrations.length > 0) {
    target.INTEGRATIONS_TO_SPAWN_JSON = JSON.stringify(spec.integrations);
  }
  // Platform runtime tools (output/log/note/pin/report) the sidecar hosts
  // as in-process MCP tools, plus the output schema they validate against.
  if (spec.runtimeTools && spec.runtimeTools.length > 0) {
    target.RUNTIME_TOOLS_JSON = JSON.stringify(spec.runtimeTools);
  }
  if (spec.outputSchema) {
    target.OUTPUT_SCHEMA = JSON.stringify(spec.outputSchema);
  }
  // P4 — connect-run mode. When set, the sidecar runs `runConnectOnce`
  // against this single integration and exits (no agent /mcp server).
  if (spec.connectLoginSpec) {
    target.CONNECT_LOGIN_JSON = JSON.stringify(spec.connectLoginSpec);
  }
}
