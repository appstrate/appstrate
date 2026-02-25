import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";

export interface ProxyDefinition {
  id: string;
  label: string;
  url: string;
  isDefault?: boolean;
  enabled?: boolean;
}

let BUILT_IN_PROXIES: Map<string, ProxyDefinition> | null = null;

function isValidProxy(p: ProxyDefinition): boolean {
  return !!(p.id && p.label && p.url);
}

function addProxies(
  map: Map<string, ProxyDefinition>,
  proxies: ProxyDefinition[],
  source: string,
  warnOverride = false,
): void {
  for (const p of proxies) {
    if (!isValidProxy(p)) {
      logger.error(`[proxy-registry] ${source}: skipping invalid entry (missing id/label/url)`, {
        proxy: p,
      });
      continue;
    }
    if (warnOverride && map.has(p.id)) {
      logger.warn(`[proxy-registry] ${source} overrides file proxy '${p.id}'`);
    }
    map.set(p.id, p);
  }
}

function parseEnvProxies(): ProxyDefinition[] {
  const raw = getEnv().SYSTEM_PROXIES;
  return raw as ProxyDefinition[];
}

/**
 * Initialize built-in proxies from file-based definitions + env var.
 * File proxies are loaded first, then env var entries override (with a warning).
 * Call once at boot before any proxy lookups.
 */
export function initBuiltInProxies(fileProxies?: ProxyDefinition[]): void {
  const map = new Map<string, ProxyDefinition>();

  if (fileProxies) {
    addProxies(map, fileProxies, "proxies.json");
  }
  addProxies(map, parseEnvProxies(), "SYSTEM_PROXIES", true);

  BUILT_IN_PROXIES = map;
}

export function getBuiltInProxies(): ReadonlyMap<string, ProxyDefinition> {
  if (!BUILT_IN_PROXIES) {
    throw new Error(
      "[proxy-registry] Built-in proxies not initialized. Call initBuiltInProxies() at boot.",
    );
  }
  return BUILT_IN_PROXIES;
}

export function isBuiltInProxy(proxyId: string): boolean {
  return BUILT_IN_PROXIES?.has(proxyId) ?? false;
}
