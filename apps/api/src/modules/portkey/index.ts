// SPDX-License-Identifier: Apache-2.0

/**
 * Portkey gateway module — phase 1 stateless proxy integration (#437).
 *
 * When loaded (`MODULES=portkey,…`), spawns the open-source Portkey AI
 * Gateway as a local sub-process and re-points every API-key LLM call
 * through it via the sidecar's `/llm/*` reverse proxy. Phase 1 keeps
 * everything stateless — credential decryption + provider catalog stay
 * in `apps/api`; Portkey just routes, retries (with `Retry-After`
 * honoring + backoff), and emits OTel metrics. Subscription-OAuth
 * providers (Codex, Claude Pro) bypass Portkey — see
 * `services/run-launcher/pi.ts` and the epic's non-scope section.
 *
 * When absent (default OSS), `setPortkeyRouter(null)` stays null and
 * the legacy direct-upstream path is unchanged. Zero footprint.
 */

import type { AppstrateModule } from "@appstrate/core/module";
import { getEnv } from "@appstrate/env";
import { logger } from "../../lib/logger.ts";
import { setPortkeyRouter, type PortkeyRouter } from "../../services/portkey-router.ts";
import { buildPortkeyRouting } from "./config.ts";
import { getPortkeyPort, startPortkey, stopPortkey } from "./lifecycle.ts";

/**
 * Resolve the URL the sidecar uses to reach Portkey. Containers can't
 * resolve `127.0.0.1` of the host, so the sidecar relies on Docker's
 * `host.docker.internal` (`extraHosts` is already wired by the
 * orchestrator). On Linux without Docker Desktop this requires either
 * Docker 20.10+ (auto-resolves) or the platform to publish Portkey on a
 * shared user-defined network. Phase 1 stays simple — operators on
 * unusual hosts can override via `PORTKEY_URL_FOR_SIDECAR` once we add
 * it; for now the only knob is `PORTKEY_PORT`.
 */
function portkeyUrlForSidecar(port: number): string {
  return `http://host.docker.internal:${port}`;
}

const portkeyModule: AppstrateModule = {
  manifest: { id: "portkey", name: "Portkey Gateway", version: "1.0.0" },

  async init() {
    const port = getEnv().PORTKEY_PORT;
    await startPortkey({ port });

    const sidecarUrl = portkeyUrlForSidecar(port);

    const router: PortkeyRouter = (model) => buildPortkeyRouting(model, sidecarUrl);
    setPortkeyRouter(router);

    logger.info("Portkey module ready", { port, sidecarUrl });
  },

  async shutdown() {
    setPortkeyRouter(null);
    const port = getPortkeyPort();
    await stopPortkey();
    if (port !== null) logger.info("Portkey module stopped", { port });
  },

  features: { portkey: true },
};

export default portkeyModule;
