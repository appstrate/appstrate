import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";

export interface ProxyDefinition {
  id: string;
  label: string;
  url: string;
  isDefault?: boolean;
  enabled?: boolean;
}

let systemProxies: Map<string, ProxyDefinition> | null = null;

function isValidProxy(p: ProxyDefinition): boolean {
  return !!(p.id && p.label && p.url);
}

function parseEnvProxies(): ProxyDefinition[] {
  const raw = getEnv().SYSTEM_PROXIES;
  return raw as ProxyDefinition[];
}

/**
 * Initialize system proxies from the SYSTEM_PROXIES env var.
 * Call once at boot before any proxy lookups.
 */
export function initSystemProxies(): void {
  const map = new Map<string, ProxyDefinition>();
  const proxies = parseEnvProxies();

  for (const p of proxies) {
    if (!isValidProxy(p)) {
      logger.error(
        "[proxy-registry] SYSTEM_PROXIES: skipping invalid entry (missing id/label/url)",
        {
          proxy: p,
        },
      );
      continue;
    }
    map.set(p.id, p);
  }

  systemProxies = map;
}

export function getSystemProxies(): ReadonlyMap<string, ProxyDefinition> {
  if (!systemProxies) {
    throw new Error(
      "[proxy-registry] System proxies not initialized. Call initSystemProxies() at boot.",
    );
  }
  return systemProxies;
}

export function isSystemProxy(proxyId: string): boolean {
  return systemProxies?.has(proxyId) ?? false;
}
