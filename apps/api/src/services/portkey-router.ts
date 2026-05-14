// SPDX-License-Identifier: Apache-2.0

/**
 * Portkey router — process-level handoff between the optional
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
 * installs both slots at init; the legacy direct-upstream path stays the
 * fall-through when either getter returns null. Zero footprint when the
 * module is absent.
 */

/**
 * Narrow structural input — both `ResolvedModel` (from `org-models.ts`)
 * and `ResolvedProxyModel` (from `llm-proxy/types.ts`) satisfy it once
 * the proxy caller renames `upstreamApiKey → apiKey` and `api → apiShape`
 * at the call site. Keeping the router stub free of either concrete type
 * lets the module remain agnostic of where it's invoked from.
 */
export interface PortkeyModelInput {
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

/** Read the sidecar-facing router. Null when the module is not loaded. */
export function getPortkeyRouter(): PortkeyRouter | null {
  return _sidecarRouter;
}

/** Install the in-process router (`127.0.0.1:<port>`). */
export function setPortkeyInprocessRouter(router: PortkeyRouter | null): void {
  _inprocessRouter = router;
}

/** Read the in-process router. Null when the module is not loaded. */
export function getPortkeyInprocessRouter(): PortkeyRouter | null {
  return _inprocessRouter;
}
