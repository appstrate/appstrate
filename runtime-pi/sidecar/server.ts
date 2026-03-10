import { createApp } from "./app.ts";
import { createForwardProxy } from "./forward-proxy.ts";
import type { CredentialsResponse } from "./helpers.ts";

// Mutable config — can be set via env vars at startup or updated at runtime
// via POST /configure (used by sidecar pool for pre-warmed containers).
const config = {
  platformApiUrl: process.env.PLATFORM_API_URL || "http://host.docker.internal:3000",
  executionToken: process.env.EXECUTION_TOKEN || "",
  proxyUrl: process.env.PROXY_URL || "",
};

const cookieJar = new Map<string, string[]>();

async function fetchCredentials(providerId: string): Promise<CredentialsResponse> {
  const res = await fetch(`${config.platformApiUrl}/internal/credentials/${providerId}`, {
    headers: { Authorization: `Bearer ${config.executionToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch credentials for ${providerId}: ${res.status}`);
  }
  return res.json() as Promise<CredentialsResponse>;
}

const proxy = createForwardProxy({ config });
const app = createApp({
  config,
  fetchCredentials,
  cookieJar,
  isReady: () => proxy.readySync,
});

const port = parseInt(process.env.PORT || "8080", 10);
console.log(`Sidecar proxy listening on :${port}`);

export default { port, fetch: app.fetch };
