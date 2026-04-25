// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { mountMcp } from "./mcp.ts";
import { BlobStore } from "./blob-store.ts";
import {
  isBlockedUrl,
  type SidecarConfig,
  type CredentialsResponse,
  type LlmProxyConfig,
} from "./helpers.ts";

export type { SidecarConfig } from "./helpers.ts";

export interface AppDeps {
  config: SidecarConfig;
  fetchCredentials: (providerId: string) => Promise<CredentialsResponse>;
  refreshCredentials?: (providerId: string) => Promise<CredentialsResponse>;
  cookieJar: Map<string, string[]>;
  fetchFn?: typeof fetch; // default: global fetch — injectable for tests
  isReady?: () => boolean; // default: () => true — controls /health
  configSecret?: string; // One-time config secret (from CONFIG_SECRET env var)
  preConfigured?: boolean; // true when credentials come via env vars (fresh sidecar)
  /**
   * Run identifier for the agent run this sidecar serves. Used to
   * scope the MCP blob cache (Phase 3a of #276) — a single sidecar
   * process serves a single run, so the run id can be set once at
   * boot. Defaults to `"unknown"` for tests; production sets it via
   * the platform on container create / `/configure`.
   */
  runId?: string;
}

/**
 * Build the sidecar's HTTP surface. After the MCP migration the public
 * surface is intentionally small:
 *
 *   - `GET  /health`     — readiness probe.
 *   - `POST /configure`  — one-time runtime config injection (run token,
 *                          platform API URL, proxy URL, LLM config).
 *                          Pooled sidecars require a CONFIG_SECRET; fresh
 *                          sidecars boot pre-configured via env and
 *                          permanently lock this route.
 *   - `ALL  /mcp`        — JSON-RPC entrypoint mounted by `mountMcp`.
 *                          Exposes `provider_call`, `run_history`, and
 *                          `llm_complete` as MCP tools backed by the
 *                          credential-proxy core in `credential-proxy.ts`.
 *
 * The legacy `/proxy`, `/run-history`, and `/llm/*` routes were retired
 * once the runtime client switched to MCP-direct: every credential-
 * isolation invariant they enforced lives in `executeProviderCall` (in
 * `credential-proxy.ts`), and `mountMcp` now calls that helper directly
 * via `proxyDeps` instead of re-encoding args into HTTP headers and
 * round-tripping back through `/proxy`.
 */
export function createApp(deps: AppDeps): Hono {
  const { config, fetchCredentials, cookieJar } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const isReady = deps.isReady ?? (() => true);
  const reportedAuthFailures = new Set<string>();

  const app = new Hono();

  // Health check for startup readiness (includes forward proxy readiness)
  app.get("/health", (c) => {
    if (!isReady()) {
      return c.json({ status: "degraded", proxy: "not ready" }, 503);
    }
    return c.json({ status: "ok" });
  });

  // Runtime configuration endpoint (used by sidecar pool for pre-warmed containers).
  // If CONFIG_SECRET is set, requires Authorization header and disables after first use.
  // If preConfigured is set, /configure is permanently locked (fresh sidecars with env vars).
  let configUsed = false;
  app.post("/configure", async (c) => {
    // Fresh sidecars receive credentials via env vars — /configure is permanently locked
    if (deps.preConfigured) {
      return c.json({ error: "Already configured" }, 403);
    }

    // Enforce one-time config secret when set (pooled sidecars)
    if (deps.configSecret) {
      if (configUsed) {
        return c.json({ error: "Already configured" }, 403);
      }
      const auth = c.req.header("Authorization") ?? "";
      const expected = `Bearer ${deps.configSecret}`;
      // Constant-time comparison to prevent timing attacks
      if (auth.length !== expected.length) {
        return c.json({ error: "Unauthorized" }, 403);
      }
      const authBuf = Buffer.from(auth);
      const expBuf = Buffer.from(expected);
      if (!timingSafeEqual(authBuf, expBuf)) {
        return c.json({ error: "Unauthorized" }, 403);
      }
    }

    const body = await c.req.json<{
      runToken?: string;
      platformApiUrl?: string;
      proxyUrl?: string;
      llm?: LlmProxyConfig;
    }>();
    if (body.runToken) config.runToken = body.runToken;
    if (body.platformApiUrl) config.platformApiUrl = body.platformApiUrl;
    if (body.proxyUrl !== undefined) config.proxyUrl = body.proxyUrl;
    if (body.llm !== undefined) {
      if (body.llm && isBlockedUrl(body.llm.baseUrl)) {
        return c.json({ error: "LLM base URL targets a blocked network range" }, 403);
      }
      config.llm = body.llm;
    }

    configUsed = true;

    // Reset cookie jar for new run context
    cookieJar.clear();
    return c.json({ status: "configured" });
  });

  // MCP exposure — the sole agent-facing surface. `provider_call`,
  // `run_history`, and `llm_complete` are dispatched by `mountMcp`,
  // which forwards `provider_call` directly to `executeProviderCall`
  // via the shared `proxyDeps` (no header round-trip).
  const blobStore = new BlobStore(deps.runId ?? "unknown");
  mountMcp(app, {
    blobStore,
    proxyDeps: {
      config,
      cookieJar,
      fetchFn,
      fetchCredentials,
      ...(deps.refreshCredentials ? { refreshCredentials: deps.refreshCredentials } : {}),
      reportedAuthFailures,
    },
  });

  return app;
}
