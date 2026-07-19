// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar env construction shared by the orchestrators (docker, process,
 * firecracker).
 *
 * Two layers:
 *   - {@link buildBaseSidecarEnv} — the common per-run block (PORT,
 *     RUN_TOKEN, PLATFORM_API_URL, WORKSPACE_HANDLE_JSON, then the
 *     spec-driven assignments). Topology-owned differences are explicit
 *     params: the starting env (`pickOperatorSidecarEnv()` for
 *     containers/VMs vs `cleanProcessEnv()` for host subprocesses), the
 *     port, and whether `RUN_ID` is stamped.
 *   - {@link applySpecToSidecarEnv} — ONLY the env vars derived from the
 *     `SidecarLaunchSpec` whose semantics are identical across topologies.
 *
 * Deliberately NOT covered here (orchestrator-local, semantics differ):
 *   - `INTEGRATION_RUNTIME_ADAPTER` — docker unconditionally overrides,
 *     process conditionally falls back, firecracker hardcodes "process";
 *     each orchestrator layers it after the base build.
 */

import type { SidecarLaunchSpec } from "@appstrate/core/sidecar-types";
import type { WorkspaceHandle } from "@appstrate/core/platform-types";

interface BaseSidecarEnvParams {
  spec: SidecarLaunchSpec;
  /**
   * Env the sidecar starts from — topology-owned. Docker/firecracker pass
   * `pickOperatorSidecarEnv()` (curated operator knobs only); process
   * passes `cleanProcessEnv()` (full inherited host env).
   */
  baseEnv: Record<string, string>;
  /** Sidecar listen port, as the env string (`"8080"` in-container/in-guest, dynamic on the host). */
  port: string;
  platformApiUrl: string;
  /**
   * Handed to the sidecar as WORKSPACE_HANDLE_JSON so its integration
   * runtime adapter can mount/wire the same shared surface into runner
   * workloads that opt in via mcp-server `_meta["dev.appstrate/workspace"]`.
   */
  workspace: WorkspaceHandle;
  /**
   * When set, emitted as RUN_ID so the sidecar can stamp
   * `appstrate.run=<runId>` on integration runner containers it spawns
   * (orphan-reaper correlation). Process mode spawns no containers and
   * omits it.
   */
  runId?: string;
}

/**
 * Build the sidecar env block common to every orchestrator. Callers layer
 * their topology-specific extras (INTEGRATION_RUNTIME_ADAPTER) on the
 * returned record.
 */
export function buildBaseSidecarEnv(params: BaseSidecarEnvParams): Record<string, string> {
  const env: Record<string, string> = {
    ...params.baseEnv,
    PORT: params.port,
    RUN_TOKEN: params.spec.runToken,
    ...(params.runId !== undefined ? { RUN_ID: params.runId } : {}),
    PLATFORM_API_URL: params.platformApiUrl,
    WORKSPACE_HANDLE_JSON: JSON.stringify(params.workspace),
  };
  // Forward the operator's internal-egress allowlist to the sidecar under the
  // same name, so a host the platform-side checks just exempted (internal model
  // endpoint, allowlisted remote MCP server) isn't re-blocked in-run by the
  // sidecar's own literal/fail-closed gates. Empty/unset ⇒ nothing exempted.
  // Raw process.env read (with the legacy alias), NOT getEnv(): this also runs
  // inside the standalone firecracker runner daemon, which does not carry the
  // platform's required env vars (BETTER_AUTH_SECRET, …), so getEnv()'s
  // fail-fast validation would crash sidecar creation there.
  const egressAllowHosts =
    process.env.EGRESS_ALLOW_INTERNAL_HOSTS ?? process.env.OAUTH_ALLOWED_INTERNAL_IDP_HOSTS;
  if (egressAllowHosts) env.EGRESS_ALLOW_INTERNAL_HOSTS = egressAllowHosts;
  applySpecToSidecarEnv(params.spec, env);
  return env;
}

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
    if (spec.llm.authMode === "oauth") {
      // OAuth config (non-forging — the driver signs its own fingerprint): ship
      // the full LlmProxyConfig as JSON so server.ts parses it into config.llm
      // at boot. Without this, /llm/* returns 503 "LLM proxy not configured".
      target.PI_LLM_OAUTH_CONFIG_JSON = JSON.stringify(spec.llm);
    } else {
      target.PI_BASE_URL = spec.llm.baseUrl;
      target.PI_API_KEY = spec.llm.apiKey;
      target.PI_PLACEHOLDER = spec.llm.placeholder;
      // Model-alias swap (api-key path ONLY) — the real backing id rides
      // platform→sidecar only, never into the agent container. The OAuth
      // config above carries NO modelSwap (`LlmProxyOauthConfig` has no such
      // field): that mode is a pure bearer-swap and aliases are rejected for
      // oauth-subscription providers.
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
  if (spec.browserConnectSpec) {
    target.BROWSER_CONNECT_JSON = JSON.stringify(spec.browserConnectSpec);
  }
  // P4 — result-channel key. The sidecar encrypts the captured credential
  // bundle with this AES-256 key before emitting the APPSTRATE_CONNECT_RESULT
  // sentinel, keeping plaintext credentials off the captured stdout stream.
  if (spec.connectResultKey) {
    target.CONNECT_RESULT_KEY = spec.connectResultKey;
  }
}
