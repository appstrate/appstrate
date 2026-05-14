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
import {
  setPortkeyInprocessRouter,
  setPortkeyRouter,
  type PortkeyRouter,
} from "../../services/portkey-router.ts";
import {
  resetResponseCacheConfigForTesting,
  setResponseCacheConfig,
} from "../../lib/llm-proxy-cache-config.ts";
import { buildPortkeyRouting, type PortkeyRoutingOptions } from "./config.ts";
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

/**
 * In-process callers (the `apps/api` process itself, hosting
 * `services/llm-proxy/*` for remote runners) reach Portkey on the
 * loopback. The sub-process listens on `127.0.0.1:<port>`.
 */
function portkeyUrlForInprocess(port: number): string {
  return `http://127.0.0.1:${port}`;
}

const portkeyModule: AppstrateModule = {
  manifest: { id: "portkey", name: "Portkey Gateway", version: "1.0.0" },

  async init() {
    const env = getEnv();
    const port = env.PORTKEY_PORT;

    // Cache mode resolution. Portkey 1.15.2 OSS exposes a `cache: { mode }`
    // contract in its inline config but its standalone `start-server.js`
    // bundle never installs the `getFromCache` middleware — every
    // response comes back `cacheStatus: DISABLED` regardless of mode.
    // So Appstrate owns the cache layer (`services/llm-proxy/response-cache.ts`)
    // and emits a Portkey-compatible `x-portkey-cache-status: HIT|MISS`
    // header. `PORTKEY_CACHE_MODE` now gates that layer; the Portkey
    // inline `cache` field is still emitted for forward-compatibility
    // when upstream fixes the bundled server.
    //
    // - `off`     → disable response cache entirely
    // - `simple`  → enable response cache (Redis-backed when REDIS_URL
    //               is set, in-memory per-process otherwise)
    // - `semantic`→ warn unsupported (no embedding store), downgrade to
    //               `simple`. Reserved for a follow-up.
    let effectiveCacheMode: "off" | "simple" | "semantic" = env.PORTKEY_CACHE_MODE;
    if (effectiveCacheMode === "semantic") {
      logger.warn(
        "PORTKEY_CACHE_MODE=semantic is not implemented yet — needs an embedding store. Downgrading to `simple`.",
      );
      effectiveCacheMode = "simple";
    }
    setResponseCacheConfig({
      enabled: effectiveCacheMode !== "off",
      ttlSeconds: env.PORTKEY_CACHE_MAX_AGE,
    });

    await startPortkey({ port });

    const sidecarUrl = portkeyUrlForSidecar(port);
    const inprocessUrl = portkeyUrlForInprocess(port);

    const routingOptions: PortkeyRoutingOptions =
      effectiveCacheMode === "off"
        ? {}
        : {
            cache: {
              mode: effectiveCacheMode as "simple" | "semantic",
              maxAge: env.PORTKEY_CACHE_MAX_AGE,
            },
          };

    const sidecarRouter: PortkeyRouter = (model) =>
      buildPortkeyRouting(model, sidecarUrl, routingOptions);
    const inprocessRouter: PortkeyRouter = (model) =>
      buildPortkeyRouting(model, inprocessUrl, routingOptions);
    setPortkeyRouter(sidecarRouter);
    setPortkeyInprocessRouter(inprocessRouter);

    logger.info("Portkey module ready", {
      port,
      sidecarUrl,
      inprocessUrl,
      cacheMode: effectiveCacheMode,
      cacheBackend: env.REDIS_URL ? "redis" : "in-memory",
    });
  },

  async shutdown() {
    setPortkeyRouter(null);
    setPortkeyInprocessRouter(null);
    resetResponseCacheConfigForTesting();
    const port = getPortkeyPort();
    await stopPortkey();
    if (port !== null) logger.info("Portkey module stopped", { port });
  },

  features: { portkey: true },
};

export default portkeyModule;
