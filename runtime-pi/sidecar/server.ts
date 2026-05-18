// SPDX-License-Identifier: Apache-2.0

import { createApp, SIDECAR_IDLE_TIMEOUT_SECONDS } from "./app.ts";
import { createForwardProxy } from "./forward-proxy.ts";
import type { CredentialsResponse, LlmProxyConfig } from "./helpers.ts";
import { logger } from "./logger.ts";
import { OAuthTokenCache } from "./oauth-token-cache.ts";
import { bootIntegrations, readIntegrationSpecsFromEnv } from "./integrations-boot.ts";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";

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

function readPositiveIntFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  // Soft-fail at boot: if the launcher passes a garbage value we fall back
  // to the legacy run-budget-only path rather than refusing to start. The
  // platform always emits stringified positive ints — anything else is a
  // launcher bug we want surfaced via logs, not a hard sidecar crash.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn("Sidecar env: ignoring invalid value", { name, raw });
    return undefined;
  }
  return parsed;
}

// Config is set once at startup via env vars — sidecars are spawned per-run
// with credentials already baked in.
const config = {
  platformApiUrl: process.env.PLATFORM_API_URL || "http://localhost:3000",
  runToken: process.env.RUN_TOKEN || "",
  proxyUrl: process.env.PROXY_URL || "",
  llm: readLlmConfigFromEnv(),
  modelContextWindow: readPositiveIntFromEnv("MODEL_CONTEXT_WINDOW"),
  modelMaxTokens: readPositiveIntFromEnv("MODEL_MAX_TOKENS"),
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
// One cache per sidecar process — a sidecar serves a single run, so
// cross-run pollution is impossible.
const oauthTokenCache = new OAuthTokenCache({
  getPlatformApiUrl: () => config.platformApiUrl,
  getRunToken: () => config.runToken,
});

// Phase 1.4 — bootstrap declared integrations IN THE BACKGROUND so the
// sidecar's `/mcp` listener comes up immediately (the agent retries the
// MCP handshake; the per-integration spawn + listTools handshake can
// take several seconds for a fresh node_modules tree). The agent's
// first `tools/list` call then briefly awaits this promise via the
// lazy tools provider below.
let integrationTools: AppstrateToolDefinition[] = [];
const specs = readIntegrationSpecsFromEnv();
const integrationBootPromise =
  specs && specs.length > 0
    ? bootIntegrations(specs, {
        platformApiUrl: config.platformApiUrl,
        runToken: config.runToken,
      })
        .then((result) => {
          integrationTools = result.tools;
          logger.info("Integrations bootstrapped", {
            spawned: result.spawned,
            failed: result.failed,
            toolCount: result.tools.length,
          });
        })
        .catch((err) => {
          logger.error("Integration boot raised; continuing without them", {
            error: err instanceof Error ? err.message : String(err),
          });
        })
    : Promise.resolve();

const app = createApp({
  config,
  fetchCredentials,
  refreshCredentials,
  cookieJar,
  isReady: () => proxy.readySync,
  oauthTokenCache,
  additionalMcpToolsProvider: () => integrationTools,
  integrationBootPromise,
});

logger.info("Sidecar proxy listening", { port, integrationsDeclared: specs?.length ?? 0 });

// `idleTimeout` mirrors `apps/api/src/index.ts` — value + rationale live
// in `SIDECAR_IDLE_TIMEOUT_SECONDS` so the test suite can pin the bound
// without booting this entry point (which has port-binding side effects).
// See issue #426.
export default { port, fetch: app.fetch, idleTimeout: SIDECAR_IDLE_TIMEOUT_SECONDS };
