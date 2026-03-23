import { z } from "zod";
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

const proxyDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  url: z.string().min(1),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

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
    const result = proxyDefinitionSchema.safeParse(p);
    if (!result.success) {
      logger.error("[proxy-registry] SYSTEM_PROXIES: skipping invalid entry", {
        error: result.error.issues[0]?.message,
        proxy: p,
      });
      continue;
    }
    map.set(result.data.id, result.data);
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
