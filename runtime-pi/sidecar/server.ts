// SPDX-License-Identifier: Apache-2.0

import { createApp } from "./app.ts";
import { createForwardProxy } from "./forward-proxy.ts";
import type { CredentialsResponse } from "./helpers.ts";

// Mutable config — can be set via env vars at startup or updated at runtime
// via POST /configure (used by sidecar pool for pre-warmed containers).
const config = {
  platformApiUrl: process.env.PLATFORM_API_URL || "http://localhost:3000",
  executionToken: process.env.EXECUTION_TOKEN || "",
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
    headers: { Authorization: `Bearer ${config.executionToken}` },
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

const proxy = createForwardProxy({ config });
const preConfigured = Boolean(process.env.EXECUTION_TOKEN);
const app = createApp({
  config,
  fetchCredentials,
  cookieJar,
  isReady: () => proxy.readySync,
  configSecret: process.env.CONFIG_SECRET || undefined,
  preConfigured,
});

const port = parseInt(process.env.PORT || "8080", 10);
console.log(`Sidecar proxy listening on :${port}`);

export default { port, fetch: app.fetch };
