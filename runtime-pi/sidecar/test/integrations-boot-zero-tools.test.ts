// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-contract coverage: a DECLARED integration that ends boot with zero
 * callable tools must fail the run, not warn.
 *
 * Reproduces the shape that motivated the gate: an agent declared
 * `dependencies.integrations["@scope/x"]` but shipped no
 * `integrations_configuration["@scope/x"]` entry, so the spawn resolver emitted
 * a serverless spec with no `apiCalls` and the integration "booted" with an
 * empty surface, warning into the run log only.
 *
 * These tests assert the report the agent container actually reads
 * (`GET /integrations/boot-report`): `ok: false` + a `failed[]` entry is what
 * `entrypoint.ts` turns into a `die()`.
 */

import { describe, expect, it } from "bun:test";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { ApiCallToolDeps } from "../mcp.ts";
import { TokenBudget } from "../token-budget.ts";
import { bootIntegrations } from "../integrations-boot.ts";

const INTEGRATION_ID = "@quiz-room/google-business-profile";

const unreachableFetch = (async () => {
  throw new Error("api_call handler must not execute in a boot-contract test");
}) as unknown as typeof fetch;

const apiCallDeps: ApiCallToolDeps = {
  proxyDeps: {
    config: { runToken: "run-token", platformApiUrl: "http://platform.local" },
    cookieJar: new Map(),
    fetchFn: unreachableFetch,
    reportedAuthFailures: new Set(),
  },
  tokenBudget: new TokenBudget(),
};

/** Platform stub serving the one auth the healthy spec injects. */
const platformFetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes(`/internal/integration-credentials/${INTEGRATION_ID}`)) {
    return new Response(
      JSON.stringify({
        auths: [
          {
            auth_key: "primary",
            auth_type: "api_key",
            fields: { token: "primary-token" },
            authorized_uris: ["https://mybusiness.googleapis.com/**"],
          },
        ],
        delivery_plans: {
          primary: {
            header_name: "Authorization",
            header_prefix: "Bearer ",
            value: "primary-token",
            allow_server_override: false,
          },
        },
        expires_at_epoch_ms: { primary: null },
      }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ detail: `unexpected platform call: ${url}` }), {
    status: 404,
  });
}) as unknown as typeof fetch;

/** Declared serverless integration whose config selected no tool at all. */
function zeroToolSpec(): IntegrationSpawnSpec {
  return {
    integrationId: INTEGRATION_ID,
    namespace: "gbp",
    sourceKind: "none",
    manifest: { name: INTEGRATION_ID, version: "1.0.0" },
    spawnEnv: {},
    toolAllowlist: [],
  } as IntegrationSpawnSpec;
}

/**
 * Same integration under the AFPS §4.4 wildcard: the author selected EVERY
 * upstream tool (`tools: "*"` → `toolAllowlist` omitted), and there still is
 * nothing. The agent-side key is not the thing to fix here.
 */
function wildcardZeroToolSpec(): IntegrationSpawnSpec {
  return {
    integrationId: INTEGRATION_ID,
    namespace: "gbp",
    sourceKind: "none",
    manifest: { name: INTEGRATION_ID, version: "1.0.0" },
    spawnEnv: {},
  } as IntegrationSpawnSpec;
}

/** Same integration, with `api_call` actually selected. */
function healthySpec(): IntegrationSpawnSpec {
  return {
    integrationId: INTEGRATION_ID,
    namespace: "gbp",
    sourceKind: "none",
    manifest: { name: INTEGRATION_ID, version: "1.0.0" },
    apiCalls: [
      {
        authKey: "primary",
        toolName: "api_call",
        authorizedUris: ["https://mybusiness.googleapis.com/**"],
      },
    ],
    spawnEnv: {},
    toolAllowlist: ["api_call"],
  } as IntegrationSpawnSpec;
}

async function boot(spec: IntegrationSpawnSpec) {
  const previousAdapter = process.env.INTEGRATION_RUNTIME_ADAPTER;
  process.env.INTEGRATION_RUNTIME_ADAPTER = "process";
  try {
    return await bootIntegrations(
      [spec],
      {
        platformApiUrl: "http://platform.local",
        runToken: "run-token",
        fetchFn: platformFetch,
      },
      apiCallDeps,
    );
  } finally {
    if (previousAdapter === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = previousAdapter;
  }
}

describe("bootIntegrations — zero callable tools is a boot failure", () => {
  it("fails the boot report when a declared serverless integration exposes nothing", async () => {
    const result = await boot(zeroToolSpec());
    try {
      expect(result.report.ok).toBe(false);
      expect(result.report.declared).toBe(1);
      expect(result.spawned).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.integrationId).toBe(INTEGRATION_ID);
      // Actionable: names what is missing AND the manifest key to fix.
      expect(result.failed[0]!.error).toContain("nothing callable");
      expect(result.failed[0]!.error).toContain(
        `integrations_configuration["${INTEGRATION_ID}"].tools`,
      );
      expect(result.tools).toEqual([]);
    } finally {
      await result.shutdown();
    }
  });

  it("reports the failure on exactly one breadcrumb, not two", async () => {
    const result = await boot(zeroToolSpec());
    try {
      // One crumb, not two. The gate runs before the serverless "ready"
      // breadcrumb, so the failure path's `error` crumb is the only one — and
      // it carries the full actionable sentence, so nothing is lost by the
      // `warn` crumb no longer firing. Two crumbs would print the same
      // sentence twice in the run log.
      const zeroToolCrumbs = result.report.breadcrumbs.filter(
        (b) => b.message.includes("api_call exposed 0 tools") && b.message.includes(INTEGRATION_ID),
      );
      expect(zeroToolCrumbs).toHaveLength(1);
      expect(zeroToolCrumbs[0]!.level).toBe("error");
      expect(zeroToolCrumbs[0]!.message).toContain(
        `integrations_configuration["${INTEGRATION_ID}"].tools`,
      );
      // The spawn mode survives on the failure crumb (the serverless "ready"
      // crumb that used to carry it never runs on this path).
      expect(zeroToolCrumbs[0]!.data).toMatchObject({ kind: "serverless" });
    } finally {
      await result.shutdown();
    }
  });

  it("blames the integration, not the agent's tools key, under the wildcard", async () => {
    // Under `tools: "*"` the author already selected everything; pointing them
    // at `integrations_configuration[id].tools` would send them to fix the one
    // field that is already correct.
    const result = await boot(wildcardZeroToolSpec());
    try {
      expect(result.report.ok).toBe(false);
      expect(result.failed).toHaveLength(1);
      const error = result.failed[0]!.error;
      expect(error).toContain('tools: "*"');
      expect(error).toContain("advertised no tool");
      expect(error).toContain("hidden_tools");
      expect(error).not.toContain(`Check integrations_configuration["${INTEGRATION_ID}"].tools`);
    } finally {
      await result.shutdown();
    }
  });

  it("still reports ok for a healthy integration (no regression)", async () => {
    const result = await boot(healthySpec());
    try {
      expect(result.report.ok).toBe(true);
      expect(result.failed).toEqual([]);
      expect(result.spawned).toHaveLength(1);
      expect(result.spawned[0]!.toolCount).toBe(1);
      expect(result.tools.map((t) => t.descriptor.name)).toEqual(["gbp__api_call"]);
    } finally {
      await result.shutdown();
    }
  });
});
