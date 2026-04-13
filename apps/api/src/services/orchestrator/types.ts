// SPDX-License-Identifier: Apache-2.0

export interface WorkloadHandle {
  readonly id: string;
  readonly runId: string;
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
  runId: string;
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

export type { SidecarConfig, LlmProxyConfig } from "@appstrate/core/sidecar-types";

export interface CleanupReport {
  workloads: number;
  isolationBoundaries: number;
}

export type StopResult = "stopped" | "not_found" | "already_stopped";
