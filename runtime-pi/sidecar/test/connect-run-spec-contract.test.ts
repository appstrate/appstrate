// SPDX-License-Identifier: Apache-2.0

/**
 * `runConnectOnce` — the sidecar entry point every orchestrated `connect.tool`
 * / `runAt: "link"` login goes through — had no test at all. The gap let a
 * live regression ship: `spawnAndConnectLocalIntegration` hard-fails a
 * `sourceKind: "local"` spec that names no `server.packageId` (correct — the
 * old fallback fetched the INTEGRATION's own bundle into a code-execution
 * position), while the platform-side spec builder emitted only
 * `{ type, entry_point }`. Every orchestrated login therefore aborted at boot
 * with `APPSTRATE_CONNECT_ERROR`, and the platform-side unit test stayed green
 * because it pinned the truncated shape.
 *
 * This file owns the SIDECAR half of that contract: what `runConnectOnce`
 * requires of a connect spec, and which bytes it reaches for. The PLATFORM
 * half — that `buildConnectLoginSpec` actually emits this shape — is pinned in
 * `apps/api/test/unit/services/connect-run-launcher.test.ts`. The two are kept
 * apart deliberately: `apps/api` and the sidecar never import each other
 * statically (see `process-orchestrator.ts`, which reaches the sidecar entry
 * by path string), so each side pins its half and names the other.
 *
 * Both cases run fully in-process and stop at the bundle route, before any
 * runner is spawned.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { runConnectOnce } from "../integrations-boot.ts";

const INTEGRATION_ID = "@scope/connect-it";
const SERVER_ID = "@scope/connect-srv";
const SERVER_VERSION = "1.4.2";

/**
 * The spec `buildConnectLoginSpec` produces, field for field. `server` is the
 * only part under test — the rest is the minimum `runConnectOnce` needs to get
 * past its own preconditions (`connectLogin`, `manifest.server`, a non-remote
 * `sourceKind`).
 */
function connectSpec(server: Record<string, unknown>): IntegrationSpawnSpec {
  return {
    integrationId: INTEGRATION_ID,
    namespace: INTEGRATION_ID,
    sourceKind: "local",
    manifest: { name: INTEGRATION_ID, version: "1.0.0", server },
    spawnEnv: {},
    httpDeliveryAuths: {
      session: {
        authType: "custom",
        headerName: "",
        headerPrefix: "",
        value: "",
        allowServerOverride: false,
        authorizedUris: ["https://api.example.test/**"],
        expiresAtEpochMs: null,
      },
    },
    toolAllowlist: [],
    connectLogin: {
      toolName: "login",
      produces: ["session_token"],
      authKey: "session",
      authType: "custom",
      authorizedUris: ["https://api.example.test/**"],
      deliveryHttp: {
        in: "header",
        name: "Authorization",
        prefix: "Bearer ",
        value: "{$credential.session_token}",
      },
      inputs: { email: "a@b.c", password: "pw" },
    },
  } as unknown as IntegrationSpawnSpec;
}

/**
 * Drive one connect-run, recording every bundle URL the sidecar asked for. The
 * bundle route answers 502 — WHICH package (and which version) it reached for
 * is the whole subject, so the bytes are refused rather than faked.
 */
async function connectRun(spec: IntegrationSpawnSpec): Promise<{
  error: string;
  bundleUrls: string[];
}> {
  const bundleUrls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/internal/mcp-server-bundle/")) {
      bundleUrls.push(url);
      return new Response(JSON.stringify({ detail: "bundle route reached" }), { status: 502 });
    }
    if (url.includes("/internal/integration-credentials/")) {
      // Placeholder session — the real one is what the login tool would mint.
      return new Response(JSON.stringify({ auths: [], delivery_plans: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ detail: `unexpected: ${url}` }), { status: 404 });
  }) as unknown as typeof fetch;

  const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
  process.env.INTEGRATION_RUNTIME_ADAPTER = "process";
  try {
    await runConnectOnce(spec, {
      platformApiUrl: "http://platform.local",
      runToken: "connect-token",
      fetchFn,
    });
    return { error: "", bundleUrls };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), bundleUrls };
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
  }
}

describe("runConnectOnce — the connect spec the platform builder must emit", () => {
  it("reaches the referenced mcp-server's bundle, at the resolved version", async () => {
    const { error, bundleUrls } = await connectRun(
      connectSpec({
        type: "python",
        entry_point: "./server.py",
        packageId: SERVER_ID,
        version: SERVER_VERSION,
      }),
    );
    expect(bundleUrls).toHaveLength(1);
    // The mcp-server package, NOT the integration's own bundle.
    expect(bundleUrls[0]).toContain(`/internal/mcp-server-bundle/${SERVER_ID}`);
    expect(bundleUrls[0]).not.toContain(INTEGRATION_ID);
    // #588 — the byte route rejects an absent `?version=` past the system
    // short-circuit, so the concrete version has to ride along.
    expect(bundleUrls[0]).toContain(`?version=${SERVER_VERSION}`);
    // Past the guard: the run failed on the refused bytes, not on the spec.
    expect(error).toContain("bundle route reached");
  });

  it("regression: the truncated `{ type, entry_point }` spec aborts before any fetch", async () => {
    const { error, bundleUrls } = await connectRun(
      connectSpec({ type: "python", entry_point: "./server.py" }),
    );
    expect(error).toContain(INTEGRATION_ID);
    expect(error).toContain("no server.packageId");
    // The point of the failure: it never reached for another package's bytes.
    expect(bundleUrls).toEqual([]);
  });
});
