// SPDX-License-Identifier: Apache-2.0

import { createApp } from "./app.ts";
import { createForwardProxy } from "./forward-proxy.ts";
import type { CredentialsResponse, LlmProxyConfig } from "./helpers.ts";
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
const app = createApp({
  config,
  fetchCredentials,
  refreshCredentials,
  cookieJar,
  isReady: () => proxy.readySync,
  configSecret: process.env.CONFIG_SECRET || undefined,
  preConfigured,
  oauthTokenCache,
});

logger.info("Sidecar proxy listening", { port });

// `idleTimeout: 255` mirrors `apps/api/src/index.ts` — Bun.serve's default
// of 10 s otherwise kills any LLM stream that goes quiet (reasoning phase,
// parallel tool-call generation, slow upstream networks) longer than that,
// surfacing as `terminated` / `connection lost` to the agent which then
// retries the same turn until the run timeout fires. 255 s is the maximum
// allowed by Bun and sits comfortably under the 300 s run-tracker ceiling.
// See issue #426.
export default { port, fetch: app.fetch, idleTimeout: 255 };
