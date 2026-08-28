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

/** One platform call the sidecar made, in the order it made it. */
interface InternalCall {
  method: string;
  /** Path + query only — the base URL is fixture noise. */
  path: string;
  authorization: string | null;
}

/**
 * Drive one connect-run, recording every `/internal/*` call the sidecar made.
 * The bundle route answers 502 — WHICH package (and which version) it reached
 * for is the whole subject, so the bytes are refused rather than faked.
 *
 * The FULL call list matters as much as the bundle URL: the platform grants a
 * connect run exactly the surfaces this list names (see
 * `apps/api/src/services/connect/connect-run-grant.ts`), so a connect run that
 * quietly starts calling a third `/internal/*` endpoint must fail here rather
 * than 404 in production against a grant that never covered it.
 */
async function connectRun(
  spec: IntegrationSpawnSpec,
  /**
   * What the platform's credentials GET answers. Defaults to the connect
   * branch's real reply: `200` with an EMPTY payload.
   */
  credentialsResponse: () => Response = () =>
    new Response(JSON.stringify({ auths: [], delivery_plans: {} }), { status: 200 }),
): Promise<{
  error: string;
  bundleUrls: string[];
  internalCalls: InternalCall[];
}> {
  const bundleUrls: string[] = [];
  const internalCalls: InternalCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/internal/")) {
      const headers = new Headers(init?.headers ?? {});
      internalCalls.push({
        method: init?.method ?? "GET",
        path: url.replace("http://platform.local", ""),
        authorization: headers.get("Authorization"),
      });
    }
    if (url.includes("/internal/mcp-server-bundle/")) {
      bundleUrls.push(url);
      return new Response(JSON.stringify({ detail: "bundle route reached" }), { status: 502 });
    }
    if (url.includes("/internal/integration-credentials/")) {
      return credentialsResponse();
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
    return { error: "", bundleUrls, internalCalls };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      bundleUrls,
      internalCalls,
    };
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

  it("a non-2xx credentials answer aborts the connect run BEFORE any bundle fetch", async () => {
    // Why the platform's credentials route MUST answer 2xx for a connect
    // token, and why fixing only the bundle route would have left the run dead
    // one call earlier: `fetchInitialIntegrationCredentials` throws on any
    // non-2xx, `runConnectOnce` awaits it before the spawn, and the only
    // handler around it is a `finally`. The empty `bundleUrls` is the load-
    // bearing half — this is the wall the connect run hits FIRST.
    const { error, bundleUrls } = await connectRun(
      connectSpec({
        type: "python",
        entry_point: "./server.py",
        packageId: SERVER_ID,
        version: SERVER_VERSION,
      }),
      () => new Response(JSON.stringify({ detail: "Run not found" }), { status: 404 }),
    );
    expect(error).toContain("Run not found");
    expect(bundleUrls).toEqual([]);
  });

  it("an EMPTY credentials payload does NOT short-circuit the connect path", async () => {
    // The control that keeps the test above honest: `200` + empty is what the
    // platform's connect branch returns, and it must carry the run all the way
    // to the bundle fetch — the MITM listener is mounted from that (empty)
    // source before the bytes are even requested, because `runConnectOnce`
    // hardcodes `wantsMitm: true` instead of inferring it from payload
    // emptiness the way the agent-run path does. Catches a future change that
    // reads "no auths" as "no MITM needed" here.
    const { error, bundleUrls } = await connectRun(
      connectSpec({
        type: "python",
        entry_point: "./server.py",
        packageId: SERVER_ID,
        version: SERVER_VERSION,
      }),
    );
    expect(bundleUrls).toHaveLength(1);
    expect(error).toContain("bundle route reached");
  });

  it("calls exactly TWO platform surfaces, both bearing the connect run token", async () => {
    // The platform authorises a connect run against a grant naming ONE
    // integration and ONE mcp-server, because those are the only two surfaces
    // a connect run reaches. This pins that list from the sidecar side, in
    // order: the credentials seed comes FIRST (`runConnectOnce` awaits it
    // before the spawn and throws on any non-2xx), the bundle bytes second.
    //
    // A third entry appearing here is not a test failure to silence — it means
    // a connect run now needs a surface its grant does not cover, and the
    // grant must be widened deliberately (`connect-run-grant.ts`).
    const { internalCalls } = await connectRun(
      connectSpec({
        type: "python",
        entry_point: "./server.py",
        packageId: SERVER_ID,
        version: SERVER_VERSION,
      }),
    );
    expect(internalCalls).toEqual([
      {
        method: "GET",
        path: `/internal/integration-credentials/${INTEGRATION_ID}`,
        authorization: "Bearer connect-token",
      },
      {
        method: "GET",
        path: `/internal/mcp-server-bundle/${SERVER_ID}?version=${SERVER_VERSION}`,
        authorization: "Bearer connect-token",
      },
    ]);
  });
});
