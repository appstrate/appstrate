// SPDX-License-Identifier: Apache-2.0

/**
 * A `source.kind: "local"` spawn spec MUST name the mcp-server package whose
 * bundle the sidecar fetches, extracts and executes. `server.packageId` is
 * optional in TypeScript only because the `server` bag is the collapsed union
 * of the local / remote / serverless shapes — absent on a local spec means the
 * spec did not come from a conforming manifest.
 *
 * It used to fall back to `spec.integrationId`, which silently fetched a
 * DIFFERENT package's bytes (the integration's own bundle) into a
 * code-selection position. Now it fails the spec, the same posture the
 * sibling `server.transport` field takes on the remote leg.
 *
 * Runs fully in-process — both cases stop at the bundle route, before any
 * runner is spawned.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { bootIntegrations } from "../integrations-boot.ts";

const INTEGRATION_ID = "@tractr/local-integration";
const SERVER_ID = "@tractr/local-server";

function localSpec(server: Record<string, unknown>): IntegrationSpawnSpec {
  return {
    integrationId: INTEGRATION_ID,
    namespace: "local",
    sourceKind: "local",
    manifest: { name: INTEGRATION_ID, version: "1.0.0", server },
    spawnEnv: {},
  } as unknown as IntegrationSpawnSpec;
}

/** Boot one spec, recording every bundle URL the sidecar asked for. */
async function boot(spec: IntegrationSpawnSpec) {
  const bundleUrls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/internal/mcp-server-bundle/")) {
      bundleUrls.push(url);
      // Refuse the bytes — WHICH package was asked for is the whole subject.
      return new Response(JSON.stringify({ detail: "bundle route reached" }), { status: 502 });
    }
    return new Response(JSON.stringify({ detail: `unexpected: ${url}` }), { status: 404 });
  }) as unknown as typeof fetch;

  const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
  process.env.INTEGRATION_RUNTIME_ADAPTER = "process";
  try {
    const result = await bootIntegrations(
      [spec],
      { platformApiUrl: "http://platform.local", runToken: "run-token", fetchFn },
      undefined,
    );
    return { result, bundleUrls };
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
  }
}

describe("local integration spawn — server.packageId is required", () => {
  it("fails the spec when a local source names no mcp-server package", async () => {
    const { result, bundleUrls } = await boot(
      localSpec({ type: "bun", entry_point: "./server.ts" }),
    );
    try {
      expect(result.report.ok).toBe(false);
      expect(result.failed).toHaveLength(1);
      const error = result.failed[0]!.error;
      expect(error).toContain(INTEGRATION_ID);
      expect(error).toContain("no server.packageId");
      // The point of the failure: it never reached for another package's bytes.
      expect(bundleUrls).toEqual([]);
    } finally {
      await result.shutdown();
    }
  });

  it("control: a local source naming its mcp-server still fetches THAT package", async () => {
    const { result, bundleUrls } = await boot(
      localSpec({ type: "bun", entry_point: "./server.ts", packageId: SERVER_ID }),
    );
    try {
      expect(bundleUrls).toHaveLength(1);
      expect(bundleUrls[0]).toContain(`/internal/mcp-server-bundle/${SERVER_ID}`);
      // Past the guard — the boot failed on the refused bytes, not on the spec.
      expect(result.failed[0]!.error).toContain("bundle route reached");
    } finally {
      await result.shutdown();
    }
  });
});
