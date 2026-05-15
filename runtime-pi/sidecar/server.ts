// SPDX-License-Identifier: Apache-2.0

import { createApp, SIDECAR_IDLE_TIMEOUT_SECONDS } from "./app.ts";
import { createForwardProxy } from "./forward-proxy.ts";
import type { CredentialsResponse, LlmProxyConfig, ModelApiShape } from "./helpers.ts";
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

const KNOWN_MODEL_API_SHAPES = new Set<ModelApiShape>([
  "anthropic-messages",
  "openai-chat",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "google-generative-ai",
  "google-vertex",
  "azure-openai-responses",
  "bedrock-converse-stream",
]);

function readModelApiShapeFromEnv(): ModelApiShape | undefined {
  const raw = process.env.MODEL_API_SHAPE;
  if (!raw) return undefined;
  if (!KNOWN_MODEL_API_SHAPES.has(raw as ModelApiShape)) {
    // Same soft-fail policy as the numeric envs — fall back to the legacy
    // estimator rather than crash. An unknown apiShape means the launcher
    // version drifted ahead of the runtime image; the apiShape-tuned
    // estimator is a precision win, not a correctness gate.
    logger.warn("Sidecar env: ignoring unknown MODEL_API_SHAPE", { raw });
    return undefined;
  }
  return raw as ModelApiShape;
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
  modelApiShape: readModelApiShapeFromEnv(),
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
const app = createApp({
  config,
  fetchCredentials,
  refreshCredentials,
  cookieJar,
  isReady: () => proxy.readySync,
  oauthTokenCache,
});

logger.info("Sidecar proxy listening", { port });

// `idleTimeout` mirrors `apps/api/src/index.ts` — value + rationale live
// in `SIDECAR_IDLE_TIMEOUT_SECONDS` so the test suite can pin the bound
// without booting this entry point (which has port-binding side effects).
// See issue #426.
export default { port, fetch: app.fetch, idleTimeout: SIDECAR_IDLE_TIMEOUT_SECONDS };
