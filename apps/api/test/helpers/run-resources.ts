// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_AGENT_CPU,
  DEFAULT_AGENT_MEMORY_MB,
  type ResolvedAgentResources,
} from "../../src/services/run-limits.ts";

export function defaultTestAgentResources(): ResolvedAgentResources {
  return {
    requested: { memoryMb: DEFAULT_AGENT_MEMORY_MB, cpu: DEFAULT_AGENT_CPU },
    effective: { memoryMb: DEFAULT_AGENT_MEMORY_MB, cpu: DEFAULT_AGENT_CPU },
    memoryCapped: false,
    cpuCapped: false,
    workload: {
      memoryBytes: DEFAULT_AGENT_MEMORY_MB * 1024 * 1024,
      nanoCpus: DEFAULT_AGENT_CPU * 1_000_000_000,
    },
  };
}
