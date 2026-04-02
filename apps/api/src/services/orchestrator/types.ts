// SPDX-License-Identifier: Apache-2.0

export interface WorkloadHandle {
  readonly id: string;
  readonly executionId: string;
  readonly role: string;
}

export interface WorkloadResources {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit?: number;
}

export interface InjectableFile {
  name: string;
  content: Buffer;
}

export interface WorkloadSpec {
  executionId: string;
  role: string;
  image: string;
  env: Record<string, string>;
  resources: WorkloadResources;
  files?: { items: InjectableFile[]; targetDir: string };
}

export interface IsolationBoundary {
  readonly id: string;
  readonly name: string;
}

export interface SidecarConfig {
  executionToken: string;
  platformApiUrl: string;
  proxyUrl?: string;
  llm?: LlmProxyConfig;
}

export interface LlmProxyConfig {
  baseUrl: string;
  apiKey: string;
  placeholder: string;
}

export interface CleanupReport {
  workloads: number;
  isolationBoundaries: number;
}

export type StopResult = "stopped" | "not_found" | "already_stopped";
