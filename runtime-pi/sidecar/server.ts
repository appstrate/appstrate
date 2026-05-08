// SPDX-License-Identifier: Apache-2.0

import { Agent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import { createApp } from "./app.ts";
import { createForwardProxy } from "./forward-proxy.ts";
import type { CredentialsResponse } from "./helpers.ts";
import { logger } from "./logger.ts";

// PATCH (local) — undici h2 client has a hardcoded `bodyTimeout = 300_000`
// (5 min) default that kills LLM streaming for long agentic conversations.
// The bodyTimeout is the elapsed wall-clock between any TWO chunks of the
// streamed response — Claude can pause for >5 min between chunks when the
// agent context is large and the model is processing many tool calls.
// `setGlobalDispatcher` alone wasn't enough because Bun's native fetch
// (Zig-based) doesn't honour it; we explicitly replace globalThis.fetch
// with the undici-backed fetch using a custom agent that disables both
// timeouts. This is the actual fix that resolves the silent 5-min wall.
const undiciAgent = new Agent({ bodyTimeout: 0, headersTimeout: 0 });
setGlobalDispatcher(undiciAgent);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  undiciFetch(
    input as never,
    { ...(init as never), dispatcher: undiciAgent } as never,
  )) as typeof fetch;

// Mutable config — can be set via env vars at startup or updated at runtime
// via POST /configure (used by sidecar pool for pre-warmed containers).
const config = {
  platformApiUrl: process.env.PLATFORM_API_URL || "http://localhost:3000",
  runToken: process.env.RUN_TOKEN || "",
  proxyUrl: process.env.PROXY_URL || "",
  llm:
    process.env.PI_BASE_URL && process.env.PI_API_KEY
      ? {
          baseUrl: process.env.PI_BASE_URL,
          apiKey: process.env.PI_API_KEY,
          placeholder: process.env.PI_PLACEHOLDER || "sk-placeholder",
        }
      : undefined,
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
const app = createApp({
  config,
  fetchCredentials,
  refreshCredentials,
  cookieJar,
  isReady: () => proxy.readySync,
  configSecret: process.env.CONFIG_SECRET || undefined,
  preConfigured,
});

logger.info("Sidecar proxy listening", { port });

export default { port, fetch: app.fetch };
