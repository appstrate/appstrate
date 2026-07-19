// SPDX-License-Identifier: Apache-2.0

import type { BrowserExecutionSpec } from "@appstrate/core/sidecar-types";

export interface BrowserResourceProfile {
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  readonly shmBytes: number;
  readonly maxContexts: number;
  readonly maxPages: number;
}

export interface BrowserEgressContext {
  readonly proxyUrl: string;
  readonly authToken: string;
}

export interface BrowserProviderRunContext {
  readonly runId: string;
}

export interface SpawnBrowserOptions {
  readonly runId: string;
  readonly integrationId: string;
  readonly spec: BrowserExecutionSpec;
  readonly egress: BrowserEgressContext;
  readonly resources: BrowserResourceProfile;
}

export interface BrowserHandle {
  readonly id: string;
  readonly endpoint: string;
  readonly authToken: string;
  readonly workerBuildId: string;
  readonly protocolVersion: number;
  readonly browserRevision: string;
  readonly diagnosticId: string | null;
}

export interface BrowserProvider {
  readonly id: string;
  prepare(runId: string): Promise<BrowserProviderRunContext>;
  spawn(options: SpawnBrowserOptions): Promise<BrowserHandle>;
  stop(handle: BrowserHandle): Promise<void>;
  shutdown(): Promise<void>;
}

export interface BrowserProviderEntry {
  readonly id: string;
  create(): BrowserProvider;
}

const WORKER_PROTOCOL_BY_CAPABILITY = {
  "cdp-v1": 1,
} as const satisfies Record<BrowserExecutionSpec["protocol"], number>;

export function assertBrowserWorkerCompatible(
  protocol: BrowserExecutionSpec["protocol"],
  handle: Pick<BrowserHandle, "protocolVersion" | "browserRevision">,
): void {
  const expected = WORKER_PROTOCOL_BY_CAPABILITY[protocol];
  if (handle.protocolVersion !== expected) {
    throw new Error(
      `BROWSER_UNSUPPORTED_REVISION: capability ${protocol} requires worker protocol ` +
        `${expected}, received ${handle.protocolVersion} (${handle.browserRevision})`,
    );
  }
}

const registry: BrowserProviderEntry[] = [];

export function registerBrowserProvider(entry: BrowserProviderEntry): void {
  if (registry.some((candidate) => candidate.id === entry.id)) {
    throw new Error(`browser provider '${entry.id}' already registered`);
  }
  registry.push(entry);
}

export function selectBrowserProvider(env: NodeJS.ProcessEnv = process.env): BrowserProvider {
  const requested = env.BROWSER_PROVIDER ?? env.INTEGRATION_RUNTIME_ADAPTER;
  if (!requested) {
    throw new Error("BROWSER_PROVIDER is not set and no integration runtime adapter is available");
  }
  const entry = registry.find((candidate) => candidate.id === requested);
  if (!entry) {
    throw new Error(
      `browser provider '${requested}' is not registered (available: ${registry.map((e) => e.id).join(", ")})`,
    );
  }
  return entry.create();
}

export function _resetBrowserProviderRegistryForTest(): void {
  registry.length = 0;
}
