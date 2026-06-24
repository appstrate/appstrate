// SPDX-License-Identifier: Apache-2.0

import { createApp, buildSidecarRuntimeDeps, SIDECAR_IDLE_TIMEOUT_SECONDS } from "./app.ts";
import { createForwardProxy } from "./forward-proxy.ts";
import type { CredentialsResponse, LlmProxyConfig, ModelSwap } from "./helpers.ts";
import { logger } from "./logger.ts";
import { CredentialsCache } from "./credentials-cache.ts";
import { OAuthTokenCache } from "./oauth-token-cache.ts";
import {
  bootIntegrations,
  readIntegrationSpecsFromEnv,
  runConnectOnce,
} from "./integrations-boot.ts";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import type { IntegrationSpawnSpec, IntegrationBootReport } from "@appstrate/core/sidecar-types";
import { buildRuntimeToolDefs } from "@appstrate/core/runtime-tool-defs";
import { RuntimeEventJournal, journalRuntimeToolDefs } from "./runtime-event-journal.ts";

/** Parse the agent-selected runtime tools forwarded as `RUNTIME_TOOLS_JSON`. */
function readRuntimeToolsFromEnv(): string[] {
  const raw = process.env.RUNTIME_TOOLS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Parse the output schema forwarded as `OUTPUT_SCHEMA` (for the `output` tool). */
function readOutputSchemaFromEnv(): Record<string, unknown> | null {
  const raw = process.env.OUTPUT_SCHEMA;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Validate the parsed credential config crossing into the sidecar (the
 * credential-handling process). A blind `as` cast would let union drift (a
 * renamed `authMode`, a removed required field) parse cleanly and surface far
 * later as a confusing 401/503 from `/llm` or a silent 403 from
 * `/credential-vend`. We assert the discriminant + the per-mode required fields
 * here so drift fails at boot, at the cause. No Zod: the sidecar deliberately
 * carries no validation dependency; this is a focused shape guard.
 */
function assertLlmProxyConfig(value: unknown): LlmProxyConfig {
  if (!value || typeof value !== "object") {
    throw new Error("PI_LLM_OAUTH_CONFIG_JSON: expected an object");
  }
  const c = value as Record<string, unknown>;
  const need = (field: string): void => {
    if (typeof c[field] !== "string" || (c[field] as string).length === 0) {
      throw new Error(`PI_LLM_OAUTH_CONFIG_JSON: ${String(c.authMode)} config missing "${field}"`);
    }
  };
  switch (c.authMode) {
    case "api_key":
      need("baseUrl");
      need("apiKey");
      need("placeholder");
      break;
    case "oauth":
      need("baseUrl");
      need("credentialId");
      break;
    case "vend":
      need("credentialId");
      break;
    default:
      throw new Error(`PI_LLM_OAUTH_CONFIG_JSON: unknown authMode "${String(c.authMode)}"`);
  }
  return value as LlmProxyConfig;
}

function readLlmConfigFromEnv(): LlmProxyConfig | undefined {
  // OAuth/vend credentials ship as a single JSON env var carrying the full
  // LlmProxyConfig. A malformed payload here is a launcher bug — let JSON.parse
  // throw (and assertLlmProxyConfig reject shape drift) rather than fall through
  // silently to the API-key path.
  const oauthJson = process.env.PI_LLM_OAUTH_CONFIG_JSON;
  if (oauthJson) return assertLlmProxyConfig(JSON.parse(oauthJson));
  if (process.env.PI_BASE_URL && process.env.PI_API_KEY) {
    return {
      authMode: "api_key",
      baseUrl: process.env.PI_BASE_URL,
      apiKey: process.env.PI_API_KEY,
      placeholder: process.env.PI_PLACEHOLDER || "sk-placeholder",
      // Model-alias swap (api-key path). The OAuth path carries `modelSwap`
      // inside PI_LLM_OAUTH_CONFIG_JSON already. A malformed payload is a
      // launcher bug — let JSON.parse throw rather than silently disable the
      // swap (which would leak the real id to the agent).
      ...(process.env.PI_MODEL_SWAP_JSON
        ? { modelSwap: JSON.parse(process.env.PI_MODEL_SWAP_JSON) as ModelSwap }
        : {}),
    };
  }
  return undefined;
}

/** Parse the per-run egress allowlist forwarded via `EGRESS_ALLOWLIST_JSON`. */
function readEgressAllowlistFromEnv(): string[] | undefined {
  const raw = process.env.EGRESS_ALLOWLIST_JSON;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const hosts = parsed.filter((h): h is string => typeof h === "string" && h.length > 0);
      return hosts.length > 0 ? hosts : undefined;
    }
  } catch {
    // Launcher bug — surface via the warn below rather than crashing the sidecar.
    logger.warn("Sidecar env: ignoring invalid EGRESS_ALLOWLIST_JSON", { raw });
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
  egressAllowlist: readEgressAllowlistFromEnv(),
};

// M1 — fail closed: a `vend`-mode run hands the REAL subscription token into the
// container and relies on the per-run egress allowlist to keep that token from
// being exfiltrated to an attacker host. `readEgressAllowlistFromEnv` fails OPEN
// (returns `undefined`) on a missing/malformed `EGRESS_ALLOWLIST_JSON`, which
// would leave the forward proxy in SSRF-block-only mode while still vending the
// live token — a token-exfil window. The launcher always pairs the two env vars,
// but the sidecar must not trust that: refuse to boot a vend run without a
// non-empty allowlist rather than silently degrade.
if (config.llm?.authMode === "vend" && (config.egressAllowlist?.length ?? 0) === 0) {
  throw new Error(
    "Sidecar refusing to boot: vend-mode run requires a non-empty EGRESS_ALLOWLIST_JSON " +
      "(the real subscription token must never be served without the egress lock active).",
  );
}

// M1 (reverse) — fail closed: the forward proxy infers the vend egress-lock
// (deny-by-default + `:443` port-pin) purely from `egressAllowlist.length > 0`,
// independent of `authMode`. If an allowlist is set for a NON-vend run the
// proxy would silently apply that vend-only lock to an `oauth`/`api_key` run —
// an unintended egress restriction that the operator never asked for, and the
// inverse of M1's exfil window. The documented `vend ⟺ allowlist` invariant is
// an iff: enforce both directions so an allowlist can ONLY accompany a vend run.
if ((config.egressAllowlist?.length ?? 0) > 0 && config.llm?.authMode !== "vend") {
  throw new Error(
    "Sidecar refusing to boot: a non-empty EGRESS_ALLOWLIST_JSON requires a vend-mode run " +
      "(the egress lock is a vend-only invariant and must never gate an oauth/api_key run).",
  );
}

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

async function fetchCredentialsUncached(integrationId: string): Promise<CredentialsResponse> {
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

// 30s TTL + singleflight cache in front of the platform read endpoint —
// mirrors the OAuth token cache below. Without it every legacy `api_call`
// paid one platform round-trip just to re-read a stable credential bag.
const credentialsCache = new CredentialsCache(fetchCredentialsUncached);

async function fetchCredentials(integrationId: string): Promise<CredentialsResponse> {
  return credentialsCache.get(integrationId);
}

async function refreshCredentials(integrationId: string): Promise<CredentialsResponse | null> {
  const res = await fetch(
    `${config.platformApiUrl}/internal/credentials/${integrationId}/refresh`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.runToken}` },
    },
  );
  // Legacy BYOI path. Any non-OK (incl. 410) → not rotated → the proxy skips
  // the retry. This path has no AFPS connection row, so flagging is a no-op here.
  if (!res.ok) {
    // Stop serving the (likely dead) cached credential; the next
    // fetchCredentials round-trips to the platform.
    credentialsCache.invalidate(integrationId);
    return null;
  }
  const fresh = (await res.json()) as CredentialsResponse;
  // The 401-retry in credential-proxy.ts replays with `fresh` directly,
  // but subsequent api_calls within the cache TTL must also see the
  // rotated token — otherwise they'd 401 again and (with the
  // one-refresh-per-run gate) stay broken for the rest of the run.
  credentialsCache.set(integrationId, fresh);
  return fresh;
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

// Platform runtime tools (output/log/note/pin/report) the agent selected,
// hosted in-process as MCP tools on the agent-facing `/mcp` surface — the
// same transport every other tool uses, so they are no longer Pi-SDK
// extensions. Static for the run's lifetime (selection + output schema are
// fixed at boot).
//
// Each def is wrapped so its handler runs ONCE and its canonical events are
// journaled (the events sub-key is then stripped from the tool result). The
// runner drains `GET /runtime-events` and re-emits on its single sink — one
// execution, transport-agnostic, no `_meta` reliance.
const runtimeEventJournal = new RuntimeEventJournal();
const runtimeToolDefs = journalRuntimeToolDefs(
  buildRuntimeToolDefs({
    runtimeTools: readRuntimeToolsFromEnv(),
    outputSchema: readOutputSchemaFromEnv(),
  }),
  runtimeEventJournal,
) as unknown as AppstrateToolDefinition[];

let integrationTools: AppstrateToolDefinition[] = [];
const specs = readIntegrationSpecsFromEnv();
const declaredIntegrations = specs?.length ?? 0;

// H1 (defense in depth) — a `vend`-mode run hands the real subscription token to
// the in-container runner over the per-run network, where `/credential-vend` is
// gated only by network membership (same trust model as `/mcp`). That is sound
// only when the network has no untrusted peers. Integration runner containers
// join the SAME network, so a vend run MUST NOT declare integrations. The
// launcher already refuses this, but the sidecar must not trust the launcher:
// fail closed rather than spawn integration siblings that could vend the token.
if (config.llm?.authMode === "vend" && declaredIntegrations > 0) {
  throw new Error(
    "Sidecar refusing to boot: a vend-mode run cannot spawn integrations " +
      "(integration containers share the per-run network and could vend the real token).",
  );
}
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
  additionalMcpToolsProvider: () => [...runtimeToolDefs, ...integrationTools],
  integrationBootPromise,
  integrationBootReportProvider: () => integrationBootReport,
  runtimeEventJournal,
});

logger.info("Sidecar proxy listening", { port, integrationsDeclared: specs?.length ?? 0 });

// `idleTimeout` mirrors `apps/api/src/index.ts` — value + rationale live
// in `SIDECAR_IDLE_TIMEOUT_SECONDS` so the test suite can pin the bound
// without booting this entry point (which has port-binding side effects).
// See issue #426.
export default { port, fetch: app.fetch, idleTimeout: SIDECAR_IDLE_TIMEOUT_SECONDS };
