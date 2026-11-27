// SPDX-License-Identifier: Apache-2.0

/**
 * A `source.kind: "local"` integration carries its server payload in its OWN archive, so the
 * sidecar fetches `GET /internal/integration-bundle/<spec.integrationId>?version=<frozen version>`:
 * the id the spec names for the integration and the version the run froze.
 *
 * Runs fully in-process — the case stops at the bundle route, before any runner is spawned.
 */

import { describe, it, expect } from "bun:test";
import { noCallReporter } from "./helpers/call-journal.ts";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { bootIntegrations } from "../integrations-boot.ts";
import { HERMETIC_PROCESS_ADAPTER_ID } from "./helpers/hermetic-process-adapter.ts";

const CONN_A = { id: "conn-a", label: "work", accountId: null };
const INTEGRATION_ID = "@tractr/local-integration";

function localSpec(server: Record<string, unknown>): IntegrationSpawnSpec {
  return {
    integrationId: INTEGRATION_ID,
    namespace: "local",
    connection: CONN_A,
    sourceKind: "local",
    manifest: { name: INTEGRATION_ID, version: "1.0.0", server },
    spawnEnv: {},
  } as unknown as IntegrationSpawnSpec;
}

describe("local integration spawn — the bundle is keyed by the integration id", () => {
  it("fetches the integration's own archive at the frozen version", async () => {
    const bundleUrls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/internal/integration-bundle/")) {
        bundleUrls.push(url);
        // Refuse the bytes — WHICH package was asked for is the whole subject.
        return new Response(JSON.stringify({ detail: "bundle route reached" }), { status: 502 });
      }
      return new Response(JSON.stringify({ detail: `unexpected: ${url}` }), { status: 404 });
    }) as unknown as typeof fetch;

    const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
    process.env.INTEGRATION_RUNTIME_ADAPTER = HERMETIC_PROCESS_ADAPTER_ID;
    const result = await bootIntegrations(
      [
        localSpec({
          type: "bun",
          entry_point: "./server.ts",
          version: "1.2.0",
        }),
      ],
      {
        platformApiUrl: "http://platform.local",
        runToken: "run-token",
        fetchFn,
        callReporter: noCallReporter,
      },
      undefined,
    );
    try {
      expect(bundleUrls).toEqual([
        `http://platform.local/internal/integration-bundle/${INTEGRATION_ID}?version=1.2.0`,
      ]);
      // Past the spec: the boot failed on the refused bytes.
      expect(result.failed[0]!.error).toContain("bundle route reached");
    } finally {
      await result.shutdown();
      if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
      else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
    }
  });
});
