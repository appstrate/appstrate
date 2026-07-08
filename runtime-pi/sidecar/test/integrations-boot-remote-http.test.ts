// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { connectRemoteHttpIntegration, type ConnectRemoteHttpDeps } from "../integrations-boot.ts";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import type { IntegrationCredentialsSource } from "../integration-credentials-source.ts";
import type { IntegrationCredentialsWire } from "@appstrate/connect";

/**
 * Unit coverage for the Phase-7 remote-HTTP credential-injection closure
 * (`customFetch`): the security-sensitive bit that injects the resolved
 * Bearer per request and recovers from a mid-run 401. Driven entirely
 * through the DI seam — no platform endpoints, no runner container. The
 * SSRF guard stays ON even under DI: `deps.resolveHost` maps the fixture
 * hostname to a public address so the guard passes without real DNS, and
 * `guardedFetch` delegates the actual send to the stubbed global `fetch`.
 */

const SERVER_URL = "https://mcp.example.com/mcp/v1";

/** Public (unblocked) address the injected resolver returns for fixtures. */
const PUBLIC_IP = "93.184.216.34";

function spec(): IntegrationSpawnSpec {
  return {
    integrationId: "@vendor/remote",
    namespace: "remote",
    sourceKind: "remote",
    manifest: { name: "remote", version: "1.0.0", server: { url: SERVER_URL } },
    toolAllowlist: [],
  } as unknown as IntegrationSpawnSpec;
}

function wire(
  auths: Array<{ authKey: string; authType: string }>,
  deliveryPlans: Record<string, { headerName: string; headerPrefix: string; value: string }>,
): IntegrationCredentialsWire {
  return {
    auths: auths.map((a) => ({
      ...a,
      fields: {},
      authorizedUris: [],
    })),
    deliveryPlans: Object.fromEntries(
      Object.entries(deliveryPlans).map(([k, p]) => [k, { ...p, allowServerOverride: false }]),
    ),
    expiresAtEpochMs: {},
  } as unknown as IntegrationCredentialsWire;
}

/**
 * Build a fake shared source (passed as the 2nd positional arg) + deps whose
 * `createClient` captures the `customFetch` the function hands the transport,
 * so the test can invoke it directly. `refreshOnUnauthorized` is a counting
 * stub. The credentials source is no longer a DI dep — the caller hoists ONE
 * source and passes it in, so the test injects a fake source directly.
 *
 * `resolveHost` defaults to a resolver returning a public address so the
 * always-on SSRF guard passes for the fixture hostname; override it to
 * exercise the guard's blocking behavior.
 */
function makeDeps(
  initial: IntegrationCredentialsWire,
  refresh: () => Promise<boolean>,
  resolveHost: (hostname: string) => Promise<string[]> = async () => [PUBLIC_IP],
) {
  let captured: typeof fetch | undefined;
  let refreshCalls = 0;
  const source = {
    snapshot: () => initial,
    refreshOnUnauthorized: async (_authKey: string) => {
      refreshCalls += 1;
      return refresh();
    },
  } as unknown as IntegrationCredentialsSource;
  const deps: ConnectRemoteHttpDeps = {
    createClient: (async (_url: string | URL, opts: { fetch?: typeof fetch }) => {
      captured = opts.fetch;
      return {} as AppstrateMcpClient;
    }) as unknown as ConnectRemoteHttpDeps["createClient"],
    resolveHost,
  };
  return { deps, source, getFetch: () => captured!, getRefreshCalls: () => refreshCalls };
}

async function withGlobalFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

describe("connectRemoteHttpIntegration — credential injection", () => {
  it("prefers the oauth2 auth and injects its Bearer header per request", async () => {
    const initial = wire(
      [
        { authKey: "apikey", authType: "api_key" },
        { authKey: "oauth", authType: "oauth2" },
      ],
      {
        apikey: { headerName: "X-Api-Key", headerPrefix: "", value: "K" },
        oauth: { headerName: "Authorization", headerPrefix: "Bearer ", value: "TOKEN" },
      },
    );
    const { deps, source, getFetch } = makeDeps(initial, async () => true);

    const { authKey } = await connectRemoteHttpIntegration(spec(), source, deps);
    expect(authKey).toBe("oauth"); // oauth2 wins over api_key

    let seen: string | null = null;
    await withGlobalFetch(
      (async (_input: unknown, init?: RequestInit) => {
        seen = new Headers(init?.headers).get("Authorization");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
      async () => {
        await getFetch()(SERVER_URL, { method: "POST" });
      },
    );
    // Cast: TS narrows a `let` assigned only inside a closure back to its
    // initializer type (`null`); the global fetch stub mutates it at runtime.
    expect(seen as string | null).toBe("Bearer TOKEN");
  });

  it("force-refreshes once and retries on a 401", async () => {
    const initial = wire([{ authKey: "oauth", authType: "oauth2" }], {
      oauth: { headerName: "Authorization", headerPrefix: "Bearer ", value: "TOKEN" },
    });
    const { deps, source, getFetch, getRefreshCalls } = makeDeps(initial, async () => true);
    await connectRemoteHttpIntegration(spec(), source, deps);

    let calls = 0;
    const status = await withGlobalFetch(
      (async () => {
        calls += 1;
        return new Response("{}", { status: calls === 1 ? 401 : 200 });
      }) as unknown as typeof fetch,
      async () => (await getFetch()(SERVER_URL, { method: "POST" })).status,
    );

    expect(calls).toBe(2); // initial 401 + one retry
    expect(getRefreshCalls()).toBe(1);
    expect(status).toBe(200);
  });

  it("does not retry past one attempt when the refresh fails", async () => {
    const initial = wire([{ authKey: "oauth", authType: "oauth2" }], {
      oauth: { headerName: "Authorization", headerPrefix: "Bearer ", value: "TOKEN" },
    });
    const { deps, source, getFetch, getRefreshCalls } = makeDeps(initial, async () => false);
    await connectRemoteHttpIntegration(spec(), source, deps);

    let calls = 0;
    const status = await withGlobalFetch(
      (async () => {
        calls += 1;
        return new Response("{}", { status: 401 });
      }) as unknown as typeof fetch,
      async () => (await getFetch()(SERVER_URL, { method: "POST" })).status,
    );

    expect(calls).toBe(1); // refresh returned false → no retry
    expect(getRefreshCalls()).toBe(1);
    expect(status).toBe(401);
  });

  it("blocks a private-address target even when a transport factory is injected", async () => {
    const initial = wire([{ authKey: "oauth", authType: "oauth2" }], {
      oauth: { headerName: "Authorization", headerPrefix: "Bearer ", value: "TOKEN" },
    });
    // Regression: injecting `createClient`/`createSseClient` must NOT
    // disable the SSRF guard (it used to — `guardEgress` flipped off under
    // DI). The resolver maps the hostname to a private address; the guard
    // must fail closed before the Bearer ever reaches the network layer.
    const { deps, source, getFetch } = makeDeps(
      initial,
      async () => true,
      async () => ["10.0.0.5"],
    );
    await connectRemoteHttpIntegration(spec(), source, deps);

    let fetchCalls = 0;
    await withGlobalFetch(
      (async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
      async () => {
        await expect(getFetch()(SERVER_URL, { method: "POST" })).rejects.toThrow(
          /SSRF guard blocked outbound request/,
        );
      },
    );
    expect(fetchCalls).toBe(0); // fail-closed — the stubbed network layer was never reached
  });

  it("throws when no auth has a resolvable delivery plan", async () => {
    const initial = wire([{ authKey: "oauth", authType: "oauth2" }], {}); // no plans
    const { deps, source } = makeDeps(initial, async () => true);
    await expect(connectRemoteHttpIntegration(spec(), source, deps)).rejects.toThrow(
      /no auth with a resolvable delivery\.http plan/,
    );
  });

  it("throws when server.url is missing", async () => {
    const noUrl = {
      integrationId: "@vendor/remote",
      namespace: "remote",
      sourceKind: "remote",
      manifest: { name: "remote", version: "1.0.0", server: {} },
      toolAllowlist: [],
    } as unknown as IntegrationSpawnSpec;
    const initial = wire([{ authKey: "oauth", authType: "oauth2" }], {
      oauth: { headerName: "Authorization", headerPrefix: "Bearer ", value: "T" },
    });
    const { deps, source } = makeDeps(initial, async () => true);
    await expect(connectRemoteHttpIntegration(noUrl, source, deps)).rejects.toThrow(
      /no server\.url/,
    );
  });
});
