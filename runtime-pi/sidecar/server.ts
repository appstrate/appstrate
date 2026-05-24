// SPDX-License-Identifier: Apache-2.0

import { createApp, buildSidecarRuntimeDeps, SIDECAR_IDLE_TIMEOUT_SECONDS } from "./app.ts";
import { createForwardProxy } from "./forward-proxy.ts";
import type { CredentialsResponse, LlmProxyConfig } from "./helpers.ts";
import { logger } from "./logger.ts";
import { OAuthTokenCache } from "./oauth-token-cache.ts";
import {
  bootIntegrations,
  readIntegrationSpecsFromEnv,
  runConnectOnce,
} from "./integrations-boot.ts";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import type { IntegrationSpawnSpec, IntegrationBootReport } from "@appstrate/core/sidecar-types";

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

// ─── P4 — connect mode (`runAt: "link"` ephemeral connect-run) ───
// When `CONNECT_LOGIN_JSON` is present the sidecar is NOT serving an agent
// run: it runs the single integration's `login` tool exactly once via
// `runConnectOnce`, emits the captured CredentialBundle on a sentinel stdout
// line, and exits. The agent-facing `/mcp` server is never started.
//
// Result protocol (stdout, one line):
//   APPSTRATE_CONNECT_RESULT:<json>   — JSON = the CredentialBundle (exit 0)
//   APPSTRATE_CONNECT_ERROR:<message> — failure (exit 1)
// The bundle values are NEVER logged anywhere else — that line is the
// transport. The platform's connect-run launcher parses this from the
// container's stdout.
if (process.env.CONNECT_LOGIN_JSON) {
  const platformApiUrl = process.env.PLATFORM_API_URL || "http://localhost:3000";
  const runToken = process.env.RUN_TOKEN || "";
  try {
    const spec = JSON.parse(process.env.CONNECT_LOGIN_JSON) as IntegrationSpawnSpec;
    const bundle = await runConnectOnce(spec, { platformApiUrl, runToken });
    // Sentinel line — the bundle is the transport, written directly to
    // stdout (NOT via the JSON logger, which would log the secret values).
    process.stdout.write(`APPSTRATE_CONNECT_RESULT:${JSON.stringify(bundle)}\n`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`APPSTRATE_CONNECT_ERROR:${message}\n`);
    process.exit(1);
  }
}

const cookieJar = new Map<string, string[]>();

async function fetchCredentials(integrationId: string): Promise<CredentialsResponse> {
  const res = await fetch(`${config.platformApiUrl}/internal/credentials/${integrationId}`, {
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
    throw new Error(detail || `Failed to fetch credentials for ${integrationId}: ${res.status}`);
  }
  return res.json() as Promise<CredentialsResponse>;
}

async function refreshCredentials(integrationId: string): Promise<CredentialsResponse> {
  const res = await fetch(
    `${config.platformApiUrl}/internal/credentials/${integrationId}/refresh`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.runToken}` },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to refresh credentials for ${integrationId}: ${res.status}`);
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
// Run-scoped runtime deps built ONCE and shared between the integration
// boot pipeline (in-process `api_call` MCP server) and the HTTP `/mcp`
// surface (`createApp`), so both read the same blob store — resource_link
// spillover from api_call resolves via the outer server's resources/read.
const runtimeDeps = buildSidecarRuntimeDeps({
  config,
  cookieJar,
  fetchCredentials,
  refreshCredentials,
  ...(process.env.RUN_ID ? { runId: process.env.RUN_ID } : {}),
});

let integrationTools: AppstrateToolDefinition[] = [];
const specs = readIntegrationSpecsFromEnv();
const declaredIntegrations = specs?.length ?? 0;
// Boot report fetched by the agent via `GET /integrations/boot-report`. Starts
// as a synthetic empty-OK report (covers the no-integrations run); the boot
// `.then`/`.catch` below overwrite it with the real outcome.
let integrationBootReport: IntegrationBootReport = {
  ok: true,
  declared: declaredIntegrations,
  adapter: "none",
  spawned: [],
  failed: [],
  breadcrumbs: [],
};
const integrationBootPromise =
  specs && specs.length > 0
    ? bootIntegrations(
        specs,
        {
          platformApiUrl: config.platformApiUrl,
          runToken: config.runToken,
        },
        runtimeDeps,
      )
        .then((result) => {
          integrationTools = result.tools;
          integrationBootReport = result.report;
          logger.info("Integrations bootstrapped", {
            spawned: result.spawned,
            failed: result.failed,
            toolCount: result.tools.length,
          });
        })
        .catch((err) => {
          // A throw here (vs. a per-integration failure) means the whole boot
          // pass blew up — surface it as a non-OK report so the agent aborts
          // the run rather than running with a silently empty toolset.
          const error = err instanceof Error ? err.message : String(err);
          logger.error("Integration boot raised", { error });
          integrationBootReport = {
            ok: false,
            declared: declaredIntegrations,
            adapter: "unknown",
            spawned: [],
            failed: [{ integrationId: "*", error }],
            breadcrumbs: [
              { message: `integration boot raised: ${error}`, level: "error", data: { error } },
            ],
          };
        })
    : Promise.resolve();

const app = createApp({
  config,
  fetchCredentials,
  refreshCredentials,
  cookieJar,
  runtimeDeps,
  isReady: () => proxy.readySync,
  oauthTokenCache,
  additionalMcpToolsProvider: () => integrationTools,
  integrationBootPromise,
  integrationBootReportProvider: () => integrationBootReport,
});

logger.info("Sidecar proxy listening", { port, integrationsDeclared: specs?.length ?? 0 });

// `idleTimeout` mirrors `apps/api/src/index.ts` — value + rationale live
// in `SIDECAR_IDLE_TIMEOUT_SECONDS` so the test suite can pin the bound
// without booting this entry point (which has port-binding side effects).
// See issue #426.
export default { port, fetch: app.fetch, idleTimeout: SIDECAR_IDLE_TIMEOUT_SECONDS };
