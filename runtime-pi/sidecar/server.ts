// SPDX-License-Identifier: Apache-2.0

import { createApp, SIDECAR_IDLE_TIMEOUT_SECONDS } from "./app.ts";
import { createForwardProxy } from "./forward-proxy.ts";
import type { CredentialsResponse, LlmProxyConfig } from "./helpers.ts";
import {
  DEFAULT_DRAIN_TIMEOUT_MS,
  LimiterRegistry,
  drainRegistry,
  parseConcurrencyConfig,
} from "./limiter.ts";
import { logger } from "./logger.ts";
import { OAuthTokenCache } from "./oauth-token-cache.ts";

function readLlmConfigFromEnv(): LlmProxyConfig | undefined {
  // OAuth credentials ship as a single JSON env var carrying the full
  // LlmProxyOauthConfig. A malformed payload here is a launcher bug — let
  // JSON.parse throw rather than fall through silently to the API-key path.
  const oauthJson = process.env.PI_LLM_OAUTH_CONFIG_JSON;
  if (oauthJson) return JSON.parse(oauthJson) as LlmProxyConfig;
  if (process.env.PI_BASE_URL && process.env.PI_API_KEY) {
    return {
      authMode: "api_key",
      baseUrl: process.env.PI_BASE_URL,
      apiKey: process.env.PI_API_KEY,
      placeholder: process.env.PI_PLACEHOLDER || "sk-placeholder",
    };
  }
  return undefined;
}

// Mutable config — can be set via env vars at startup or updated at runtime
// via POST /configure (used by sidecar pool for pre-warmed containers).
const config = {
  platformApiUrl: process.env.PLATFORM_API_URL || "http://localhost:3000",
  runToken: process.env.RUN_TOKEN || "",
  proxyUrl: process.env.PROXY_URL || "",
  llm: readLlmConfigFromEnv(),
};

const cookieJar = new Map<string, string[]>();

async function fetchCredentials(providerId: string): Promise<CredentialsResponse> {
  const res = await fetch(`${config.platformApiUrl}/internal/credentials/${providerId}`, {
    headers: { Authorization: `Bearer ${config.runToken}` },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // ignore parse failures
    }
    throw new Error(detail || `Failed to fetch credentials for ${providerId}: ${res.status}`);
  }
  return res.json() as Promise<CredentialsResponse>;
}

async function refreshCredentials(providerId: string): Promise<CredentialsResponse> {
  const res = await fetch(`${config.platformApiUrl}/internal/credentials/${providerId}/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.runToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to refresh credentials for ${providerId}: ${res.status}`);
  }
  return res.json() as Promise<CredentialsResponse>;
}

const port = parseInt(process.env.PORT || "8080", 10);
const proxy = createForwardProxy({ config, listenPort: port + 1 });
const preConfigured = Boolean(process.env.RUN_TOKEN);
// One cache per sidecar process — a sidecar serves a single run, so
// cross-run pollution is impossible. The cache reads from the live
// `config` object via getter functions so that tokens follow the
// (potentially-pooled) runtime configuration after `/configure`.
const oauthTokenCache = new OAuthTokenCache({
  getPlatformApiUrl: () => config.platformApiUrl,
  getRunToken: () => config.runToken,
});

// Built here (not inside createApp) so the SIGTERM handler can call
// `pause()` + `onIdle()` directly without having to fish references
// out of the Hono app. Start the queue-depth watcher: any provider
// whose backlog stays > threshold for the dwell window emits one
// `appstrate.error` line (issue #435).
const providerCallLimiter = new LimiterRegistry(
  parseConcurrencyConfig(process.env.SIDECAR_PROVIDER_CALL_CONCURRENCY),
);
providerCallLimiter.startQueueDepthWatcher();

const app = createApp({
  config,
  fetchCredentials,
  refreshCredentials,
  cookieJar,
  isReady: () => proxy.readySync,
  configSecret: process.env.CONFIG_SECRET || undefined,
  preConfigured,
  oauthTokenCache,
  providerCallLimiter,
});

logger.info("Sidecar proxy listening", { port });

let drainStarted = false;
function handleSignal(signal: string): void {
  if (drainStarted) return;
  drainStarted = true;
  void drainRegistry(providerCallLimiter, signal, {
    timeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
    onStart: (e) => logger.info("sidecar.drain.start", e),
    onComplete: (e) => {
      if (e.idle) logger.info("sidecar.drain.complete", e);
      else logger.warn("sidecar.drain.timeout", e);
    },
    exit: (code) => process.exit(code),
  });
}

process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));

// `idleTimeout` mirrors `apps/api/src/index.ts` — value + rationale live
// in `SIDECAR_IDLE_TIMEOUT_SECONDS` so the test suite can pin the bound
// without booting this entry point (which has port-binding side effects).
// See issue #426.
export default { port, fetch: app.fetch, idleTimeout: SIDECAR_IDLE_TIMEOUT_SECONDS };
