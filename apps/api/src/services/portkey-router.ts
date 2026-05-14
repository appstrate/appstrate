// SPDX-License-Identifier: Apache-2.0

/**
 * Portkey router — process-level handoff between the **mandatory**
 * `apps/api/src/modules/portkey/` module and Portkey's two consumers.
 *
 * Two parallel router slots exist because Portkey has two callers that
 * reach the gateway from different network vantage points:
 *
 *   • **Sidecar** (Docker container, `runtime-pi/sidecar`): reaches the
 *     gateway via `host.docker.internal:<port>`. Wired by
 *     `apps/api/src/services/run-launcher/pi.ts` at run-start.
 *   • **In-process** (the `apps/api` process itself, hosting
 *     `services/llm-proxy/*` for remote runners — GH Action, CLI):
 *     reaches the gateway via `127.0.0.1:<port>`.
 *
 * Same inline `x-portkey-config` payload, different `baseUrl`. The module
 * installs both slots at init. `assertPortkeyRoutersInstalled()` is called
 * by `boot.ts` right after `loadModules()` and aborts startup with a clear
 * "MODULES must include portkey" error if either slot is empty.
 *
 * **Subscription-OAuth exception**: model presets whose `apiShape` is in
 * `SUBSCRIPTION_OAUTH_SHAPES` (codex, claude-code, …) never call these
 * routers — Portkey 1.15.2 OSS has no custom-provider injection mechanism,
 * so we bypass the gateway entirely for those flows. Their auth wireFormat
 * stays on the legacy sidecar path. The call sites (`run-launcher/pi.ts`,
 * `llm-proxy/core.ts`) gate on `authMode === "oauth"` already; no extra
 * branch needed here.
 */

/**
 * Narrow structural input — both `ResolvedModel` (from `org-models.ts`)
 * and `ResolvedProxyModel` (from `llm-proxy/types.ts`) satisfy it
 * directly. Keeping the router stub free of either concrete type lets
 * the module remain agnostic of where it's invoked from.
 *
 * `providerId` is the Appstrate-side registry key — the router resolves
 * it to a Portkey gateway slug via `getModelProvider(providerId)
 * ?.portkeyProvider`. `apiShape` stays load-bearing because it drives
 * the URL prefix (`/v1` vs bare) per SDK convention, independent of
 * upstream identity.
 */
export interface PortkeyModelInput {
  providerId: string;
  apiShape: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * Computed routing output: the caller points its upstream URL at
 * `baseUrl` and forwards `portkeyConfig` as the `x-portkey-config`
 * header on every request.
 */
export interface PortkeyRouting {
  baseUrl: string;
  portkeyConfig: string;
}

export type PortkeyRouter = (model: PortkeyModelInput) => PortkeyRouting | null;

let _sidecarRouter: PortkeyRouter | null = null;
let _inprocessRouter: PortkeyRouter | null = null;

/** Install the sidecar-facing router (`host.docker.internal:<port>`). */
export function setPortkeyRouter(router: PortkeyRouter | null): void {
  _sidecarRouter = router;
}

/**
 * Read the sidecar-facing router. Throws if the `portkey` module did not
 * install its slot — call sites assume `boot.ts` has already validated
 * this via `assertPortkeyRoutersInstalled()`.
 */
export function getPortkeyRouter(): PortkeyRouter {
  if (!_sidecarRouter) {
    throw new Error(
      "portkey-router: sidecar router not installed — MODULES must include 'portkey'",
    );
  }
  return _sidecarRouter;
}

/** Install the in-process router (`127.0.0.1:<port>`). */
export function setPortkeyInprocessRouter(router: PortkeyRouter | null): void {
  _inprocessRouter = router;
}

/**
 * Read the in-process router. Throws if the `portkey` module did not
 * install its slot — call sites assume `boot.ts` has already validated
 * this via `assertPortkeyRoutersInstalled()`.
 */
export function getPortkeyInprocessRouter(): PortkeyRouter {
  if (!_inprocessRouter) {
    throw new Error(
      "portkey-router: in-process router not installed — MODULES must include 'portkey'",
    );
  }
  return _inprocessRouter;
}

/**
 * Boot-time invariant check. Aborts startup with a clear error if either
 * router slot is empty after `loadModules()` — guarantees that
 * `getPortkey*Router()` will never throw at request time.
 */
export function assertPortkeyRoutersInstalled(): void {
  if (!_sidecarRouter || !_inprocessRouter) {
    throw new Error(
      "portkey-router: both router slots must be installed by the `portkey` module. " +
        "Ensure MODULES includes 'portkey'.",
    );
  }
}
