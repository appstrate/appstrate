// SPDX-License-Identifier: Apache-2.0

/**
 * A run can bind several connections of ONE integration, and each gets its own
 * spawn spec. Two consequences are pinned here:
 *
 *   - the boot report is per-CONNECTION — `spawned[]` / `failed[]` carry
 *     `connectionLabel`, and the breadcrumbs name it, because two entries
 *     otherwise share an `integrationId` and are indistinguishable;
 *   - one connection failing does not take its sibling down (it only fails the
 *     run, as any `failed[]` entry does).
 *
 * The credentials fetch is the discriminator: it is keyed by `connection_id`,
 * so the platform can answer for one connection and refuse the other.
 */

import { describe, expect, it } from "bun:test";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { ApiCallToolDeps } from "../mcp.ts";
import { TokenBudget } from "../token-budget.ts";
import { bootIntegrations } from "../integrations-boot.ts";

const INTEGRATION_ID = "@appstrate/drive";
const CONN_A = { id: "conn-a", label: "work", accountId: "work@example.com" };
const CONN_B = { id: "conn-b", label: "perso", accountId: "perso@example.com" };

const unreachableFetch = (async () => {
  throw new Error("api_call handler must not execute in a boot-report test");
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

const CREDENTIALS_WIRE = {
  auths: [
    {
      auth_key: "primary",
      auth_type: "api_key",
      fields: { token: "primary-token" },
      authorized_uris: ["https://www.googleapis.com/**"],
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
};

function spec(connection: IntegrationSpawnSpec["connection"]): IntegrationSpawnSpec {
  return {
    integrationId: INTEGRATION_ID,
    namespace: "drive",
    connection,
    sourceKind: "none",
    manifest: { name: INTEGRATION_ID, version: "1.0.0" },
    apiCalls: [
      {
        authKey: "primary",
        toolName: "api_call",
        authorizedUris: ["https://www.googleapis.com/**"],
      },
    ],
    spawnEnv: {},
    toolAllowlist: ["api_call"],
  } as IntegrationSpawnSpec;
}

/** Answers the credentials GET only for the connection ids it was given. */
function platformFetch(resolvable: readonly string[], seen: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const connectionId = url.searchParams.get("connection_id");
    seen.push(`${url.pathname}?connection_id=${connectionId}`);
    if (!url.pathname.includes("/internal/integration-credentials/")) {
      return new Response(JSON.stringify({ detail: `unexpected call: ${url.pathname}` }), {
        status: 404,
      });
    }
    if (connectionId === null || !resolvable.includes(connectionId)) {
      return new Response(JSON.stringify({ detail: `connection ${connectionId} is not bound` }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(CREDENTIALS_WIRE), { status: 200 });
  }) as unknown as typeof fetch;
}

async function boot(specs: IntegrationSpawnSpec[], resolvable: readonly string[]) {
  const seen: string[] = [];
  const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
  process.env.INTEGRATION_RUNTIME_ADAPTER = "process";
  try {
    const result = await bootIntegrations(
      specs,
      {
        platformApiUrl: "http://platform.local",
        runToken: "run-token",
        fetchFn: platformFetch(resolvable, seen),
      },
      apiCallDeps,
    );
    return { result, seen };
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
  }
}

describe("boot report — one entry per connection", () => {
  it("CONTROL — both connections resolvable: two spawned entries, distinct labels", async () => {
    const { result, seen } = await boot([spec(CONN_A), spec(CONN_B)], ["conn-a", "conn-b"]);
    try {
      expect(result.report.ok).toBe(true);
      expect(result.report.declared).toBe(2);
      expect(result.failed).toEqual([]);
      expect(result.spawned.map((entry) => entry.connectionLabel)).toEqual(["work", "perso"]);
      // Same integration, same namespace — the label is the only thing that
      // tells the two lines apart.
      expect(new Set(result.spawned.map((entry) => entry.integrationId))).toEqual(
        new Set([INTEGRATION_ID]),
      );
      // Each connection fetched its OWN credentials.
      expect(seen).toEqual([
        `/internal/integration-credentials/${INTEGRATION_ID}?connection_id=conn-a`,
        `/internal/integration-credentials/${INTEGRATION_ID}?connection_id=conn-b`,
      ]);
    } finally {
      await result.shutdown();
    }
  });

  it("one connection failing leaves its sibling spawned and names the failed label", async () => {
    const { result } = await boot([spec(CONN_A), spec(CONN_B)], ["conn-a"]);
    try {
      expect(result.report.ok).toBe(false);
      expect(result.spawned.map((entry) => entry.connectionLabel)).toEqual(["work"]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.connectionLabel).toBe("perso");
      expect(result.failed[0]!.integrationId).toBe(INTEGRATION_ID);
      expect(result.failed[0]!.error).toContain("conn-b is not bound");

      const crumb = result.report.breadcrumbs.find((b) => b.level === "error")!;
      expect(crumb.message).toContain(`${INTEGRATION_ID} [perso]`);
      expect((crumb.data as { connectionLabel?: string }).connectionLabel).toBe("perso");
      const ready = result.report.breadcrumbs.find((b) => b.message.includes("ready"))!;
      expect(ready.message).toContain(`${INTEGRATION_ID} [work]`);
    } finally {
      await result.shutdown();
    }
  });
});
