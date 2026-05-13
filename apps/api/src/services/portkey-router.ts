// SPDX-License-Identifier: Apache-2.0

/**
 * Portkey router — process-level handoff between the optional
 * `apps/api/src/modules/portkey/` module and the run launcher.
 *
 * When the Portkey module is loaded (`MODULES=portkey,…`), its `init()`
 * spawns the Portkey gateway sub-process and calls `setPortkeyRouter()`
 * with a routing function. The run launcher (`services/run-launcher/pi.ts`)
 * consults `getPortkeyRouter()` at run-start: when present, the sidecar's
 * LLM proxy gets re-pointed at Portkey with the inline `x-portkey-config`
 * carrying provider + decrypted credential + retry policy.
 *
 * The router lives **outside** `modules/portkey/` on purpose. Run launcher
 * never imports the module — when `MODULES=` excludes Portkey, this file
 * still resolves at compile time but `getPortkeyRouter()` returns null and
 * the run launcher falls through to its legacy direct-upstream path. Zero
 * footprint when disabled.
 */

import type { ResolvedModel } from "./org-models.ts";

/**
 * Computed routing output: the sidecar's LLM proxy is pointed at
 * `baseUrl` (the local Portkey gateway), and forwards every upstream
 * call carrying `portkeyConfig` as the `x-portkey-config` header.
 *
 * `baseUrl` is the Portkey URL reachable from the sidecar container —
 * typically `http://host.docker.internal:<port>` on a Docker bridge.
 */
export interface PortkeyRouting {
  baseUrl: string;
  portkeyConfig: string;
}

export type PortkeyRouter = (model: ResolvedModel) => PortkeyRouting | null;

let _router: PortkeyRouter | null = null;

/** Install the routing function. Called by `modules/portkey/index.ts` at init. */
export function setPortkeyRouter(router: PortkeyRouter | null): void {
  _router = router;
}

/** Read the current routing function. Returns null when the Portkey module is not loaded. */
export function getPortkeyRouter(): PortkeyRouter | null {
  return _router;
}
