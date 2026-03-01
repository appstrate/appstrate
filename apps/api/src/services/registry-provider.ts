import { getEnv } from "@appstrate/env";
import { RegistryClient } from "@appstrate/registry-client";
import { logger } from "../lib/logger.ts";

let registryClient: RegistryClient | null = null;
let discoveryData: { oauth?: { authorizationUrl: string; tokenUrl: string } } | null = null;

/**
 * Initialize the registry provider. Called at boot.
 * Non-fatal — if registry is unavailable, strate runs standalone.
 */
export async function initRegistryProvider(): Promise<void> {
  const env = getEnv();
  if (!env.REGISTRY_URL) {
    logger.info("No REGISTRY_URL configured — marketplace disabled");
    return;
  }

  try {
    registryClient = new RegistryClient({ baseUrl: env.REGISTRY_URL });
    discoveryData = await registryClient.discover();
    logger.info("Registry discovered", {
      url: env.REGISTRY_URL,
      hasOAuth: !!discoveryData?.oauth,
    });
  } catch (err) {
    logger.warn("Failed to discover registry — marketplace will be unavailable", {
      url: env.REGISTRY_URL,
      error: err instanceof Error ? err.message : String(err),
    });
    registryClient = null;
    discoveryData = null;
  }
}

export function getRegistryClient(): RegistryClient | null {
  return registryClient;
}

export function getRegistryDiscovery() {
  return discoveryData;
}

export function isRegistryConfigured(): boolean {
  return !!getEnv().REGISTRY_URL;
}
