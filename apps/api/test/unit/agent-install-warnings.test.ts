// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { AGENT_RESOURCES_META_KEY } from "@appstrate/core/validation";
import {
  collectAgentInstallWarnings,
  collectAgentResourceWarnings,
} from "../../src/services/agent-install-warnings.ts";
import {
  _setRunLimitsForTesting,
  type AgentResourcePolicy,
} from "../../src/services/run-limits.ts";

const docker = { semantics: "limits" } as const;
const generousPolicy: AgentResourcePolicy = {
  agent_memory_ceiling_mb: 8192,
  agent_cpu_ceiling: 16,
};

function agent(hints?: Record<string, unknown>, extras: Record<string, unknown> = {}) {
  return {
    type: "agent",
    ...extras,
    ...(hints
      ? {
          _meta: {
            [AGENT_RESOURCES_META_KEY]: hints,
          },
        }
      : {}),
  };
}

describe("collectAgentResourceWarnings", () => {
  it("stays silent for non-agents and absent extensions", () => {
    expect(
      collectAgentResourceWarnings(
        {
          type: "skill",
          _meta: { [AGENT_RESOURCES_META_KEY]: { memory_mb: 4096 } },
        },
        generousPolicy,
        docker,
      ),
    ).toEqual([]);
    expect(collectAgentResourceWarnings(agent(), generousPolicy, docker)).toEqual([]);
  });

  it("stays silent below and exactly at the effective allocation", () => {
    expect(
      collectAgentResourceWarnings(
        agent({ memory_mb: 1024, cpu: 4 }),
        { agent_memory_ceiling_mb: 2048, agent_cpu_ceiling: 4 },
        docker,
      ),
    ).toEqual([]);
  });

  it("warns in stable memory-then-CPU order for operator-capped declarations", () => {
    expect(
      collectAgentResourceWarnings(
        agent({ memory_mb: 4096, cpu: 6 }),
        { agent_memory_ceiling_mb: 1536, agent_cpu_ceiling: 2 },
        docker,
      ),
    ).toEqual([
      `_meta["${AGENT_RESOURCES_META_KEY}"].memory_mb: declared 4096 MiB exceeds this deployment's effective ceiling — runs will use 1536 MiB.`,
      `_meta["${AGENT_RESOURCES_META_KEY}"].cpu: declared 6 vCPU exceeds this deployment's effective ceiling — runs will use 2 vCPU.`,
    ]);
  });

  it("warns only for an explicitly declared capped dimension", () => {
    expect(
      collectAgentResourceWarnings(
        agent({ memory_mb: 4096 }),
        { agent_memory_ceiling_mb: 1536, agent_cpu_ceiling: 1 },
        docker,
      ),
    ).toEqual([
      `_meta["${AGENT_RESOURCES_META_KEY}"].memory_mb: declared 4096 MiB exceeds this deployment's effective ceiling — runs will use 1536 MiB.`,
    ]);
  });

  it("uses the canonical Firecracker CPU cap", () => {
    expect(
      collectAgentResourceWarnings(agent({ cpu: 8 }), generousPolicy, {
        semantics: "sizing",
        maxAgentCpu: 7,
      }),
    ).toEqual([
      `_meta["${AGENT_RESOURCES_META_KEY}"].cpu: declared 8 vCPU exceeds this deployment's effective ceiling — runs will use 7 vCPU.`,
    ]);
  });

  for (const backend of ["process", "unknown"]) {
    it(`stays silent when ${backend} declares no resource semantics`, () => {
      expect(
        collectAgentResourceWarnings(
          agent({ memory_mb: 4096, cpu: 8 }),
          { agent_memory_ceiling_mb: 1536, agent_cpu_ceiling: 2 },
          undefined,
        ),
      ).toEqual([]);
    });
  }

  it("does not hide a malformed namespace that bypassed manifest validation", () => {
    expect(() =>
      collectAgentResourceWarnings(agent({ memory_mb: 0 }), generousPolicy, docker),
    ).toThrow();
  });
});

describe("collectAgentInstallWarnings", () => {
  it("composes timeout and resource warnings without changing timeout wording", () => {
    const previousAdapter = process.env.RUN_ADAPTER;
    process.env.RUN_ADAPTER = "docker";
    _resetCacheForTesting();
    _setRunLimitsForTesting(
      {
        timeout_ceiling_seconds: 900,
        agent_memory_ceiling_mb: 1536,
        agent_cpu_ceiling: 2,
      },
      {},
    );

    try {
      expect(collectAgentInstallWarnings(agent({ memory_mb: 4096 }, { timeout: 10800 }))).toEqual([
        "timeout: declared 10800s exceeds this deployment's ceiling — runs will be capped at 900s.",
        `_meta["${AGENT_RESOURCES_META_KEY}"].memory_mb: declared 4096 MiB exceeds this deployment's effective ceiling — runs will use 1536 MiB.`,
      ]);
    } finally {
      if (previousAdapter === undefined) delete process.env.RUN_ADAPTER;
      else process.env.RUN_ADAPTER = previousAdapter;
      _resetCacheForTesting();
      _setRunLimitsForTesting({}, {});
    }
  });
});
