// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { getEnv } from "@appstrate/env";
import { loadSystemRegistry } from "../lib/system-registry.ts";

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

/**
 * Initialize system proxies from the SYSTEM_PROXIES env var.
 * Call once at boot before any proxy lookups.
 */
export function initSystemProxies(): void {
  systemProxies = loadSystemRegistry({
    name: "proxy-registry",
    envVar: "SYSTEM_PROXIES",
    entries: getEnv().SYSTEM_PROXIES as unknown[],
    schema: proxyDefinitionSchema,
    toDefinition: (p) => p,
  });
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
