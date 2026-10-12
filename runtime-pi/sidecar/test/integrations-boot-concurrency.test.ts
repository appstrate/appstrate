// SPDX-License-Identifier: Apache-2.0

/**
 * Integration boot prepares its connections concurrently and registers them
 * in spec order.
 *
 * Booting them one after the other made the boot cost the SUM of every
 * connection, so an agent with enough of them outlasted the sidecar's `/mcp`
 * wait on every run. Three properties are pinned here, each against the
 * credentials fetch — the first thing every connection's preparation awaits:
 *
 *   - preparation overlaps: several connections are in flight at once;
 *   - it is bounded: never more than the boot's concurrency limit;
 *   - registration does NOT follow completion order: the namespace a
 *     connection gets, and its place in the report, depend on the spec order
 *     alone, so a run's tool names do not change with network timing.
 */

import { describe, expect, it } from "bun:test";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { ApiCallToolDeps } from "../mcp.ts";
import { TokenBudget } from "../token-budget.ts";
import { bootIntegrations } from "../integrations-boot.ts";
import { HERMETIC_PROCESS_ADAPTER_ID } from "./helpers/hermetic-process-adapter.ts";

const BOOT_CONCURRENCY = 8;

const unreachableFetch = (async () => {
  throw new Error("api_call handler must not execute in a boot test");
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
      authorized_uris: ["https://api.example.com/**"],
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

function serverlessSpec(
  integrationId: string,
  namespace: string,
  connectionId: string,
  toolName = "api_call",
): IntegrationSpawnSpec {
  return {
    integrationId,
    namespace,
    connection: { id: connectionId, label: connectionId, accountId: `${connectionId}@example.com` },
    sourceKind: "none",
    manifest: { name: integrationId, version: "1.0.0" },
    apiCalls: [{ authKey: "primary", toolName, authorizedUris: ["https://api.example.com/**"] }],
    spawnEnv: {},
    toolAllowlist: [toolName],
  } as IntegrationSpawnSpec;
}

/**
 * A platform whose credentials answer is released by the test. `release`
 * receives the connection ids currently waiting and returns the ones to answer.
 */
function gatedPlatform(release: (waiting: readonly string[]) => readonly string[]) {
  const waiting = new Map<string, () => void>();
  let maxInFlight = 0;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const connectionId = url.searchParams.get("connection_id")!;
    await new Promise<void>((resolve) => {
      waiting.set(connectionId, resolve);
      maxInFlight = Math.max(maxInFlight, waiting.size);
      // Decide on a later tick: every connection the boot starts in this
      // pass has then had the chance to arrive.
      setTimeout(() => {
        for (const id of release([...waiting.keys()])) {
          waiting.get(id)?.();
          waiting.delete(id);
        }
      }, 0);
    });
    return new Response(JSON.stringify(CREDENTIALS_WIRE), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, maxInFlight: () => maxInFlight };
}

async function boot(specs: IntegrationSpawnSpec[], fetchFn: typeof fetch) {
  const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
  process.env.INTEGRATION_RUNTIME_ADAPTER = HERMETIC_PROCESS_ADAPTER_ID;
  try {
    return await bootIntegrations(
      specs,
      { platformApiUrl: "http://platform.local", runToken: "run-token", fetchFn },
      apiCallDeps,
    );
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
  }
}

describe("integration boot — concurrent preparation, ordered registration", () => {
  it("prepares connections at once: none is answered until all of them wait", async () => {
    const ids = ["conn-a", "conn-b", "conn-c"];
    // Answers nobody until every connection is waiting. A boot that prepared
    // them one after the other would never get its first answer.
    const platform = gatedPlatform((waiting) => (waiting.length === ids.length ? waiting : []));
    const result = await boot(
      ids.map((id) => serverlessSpec("@appstrate/drive", "drive", id)),
      platform.fetchFn,
    );
    try {
      expect(result.report.ok).toBe(true);
      expect(result.spawned.map((entry) => entry.connectionLabel)).toEqual(ids);
    } finally {
      await result.shutdown();
    }
  });

  it("never prepares more connections at once than its limit", async () => {
    const ids = Array.from({ length: BOOT_CONCURRENCY * 2 + 3 }, (_, i) => `conn-${i}`);
    // Answers a full wave, or the last, shorter one.
    let answered = 0;
    const platform = gatedPlatform((waiting) => {
      const lastWave = ids.length - answered <= waiting.length;
      if (waiting.length < BOOT_CONCURRENCY && !lastWave) return [];
      answered += waiting.length;
      return waiting;
    });
    const result = await boot(
      ids.map((id) => serverlessSpec("@appstrate/drive", "drive", id)),
      platform.fetchFn,
    );
    try {
      expect(result.report.ok).toBe(true);
      expect(result.spawned).toHaveLength(ids.length);
      expect(platform.maxInFlight()).toBe(BOOT_CONCURRENCY);
    } finally {
      await result.shutdown();
    }
  });

  it("registers in spec order, whichever connection answers first", async () => {
    // Two packages whose namespaces normalise to the same slug: the first to
    // REGISTER keeps it, the other is suffixed `_2`. The second spec's
    // credentials are answered first, the first spec's only afterwards.
    const first = serverlessSpec("@scope/drive", "@scope/drive", "conn-first");
    const second = serverlessSpec("@other/drive", "scope_drive", "conn-second", "api_call__alt");
    const order: string[] = [];
    const platform = gatedPlatform((waiting) => {
      if (waiting.length === 2) {
        order.push("conn-second");
        return ["conn-second"];
      }
      if (order.length === 1 && waiting.includes("conn-first")) {
        order.push("conn-first");
        return ["conn-first"];
      }
      return [];
    });
    const result = await boot([first, second], platform.fetchFn);
    try {
      expect(order).toEqual(["conn-second", "conn-first"]);
      expect(result.report.ok).toBe(true);
      expect(result.tools.map((tool) => tool.descriptor.name)).toEqual([
        "scope_drive__api_call",
        "scope_drive_2__api_call__alt",
      ]);
      expect(result.spawned.map((entry) => entry.integrationId)).toEqual([
        "@scope/drive",
        "@other/drive",
      ]);
      const ready = result.report.breadcrumbs
        .map((crumb) => crumb.message)
        .filter((message) => message.includes("api_call ready"));
      expect(ready.map((message) => message.split(" ")[0])).toEqual([
        "@scope/drive",
        "@other/drive",
      ]);
    } finally {
      await result.shutdown();
    }
  });
});
