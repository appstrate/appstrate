// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { connectRemoteHttpIntegration, type ConnectRemoteHttpDeps } from "../integrations-boot.ts";
import { isOperatorTrustedEgressHost } from "../ssrf.ts";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import type { IntegrationCredentialsSource } from "../integration-credentials-source.ts";
import type { IntegrationCredentialsWire } from "@appstrate/connect";

const CONN_A = { id: "conn-a", label: "work", accountId: null };

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

/**
 * Target for the guard-is-still-on case. Deliberately a host the preload's
 * `EGRESS_ALLOW_INTERNAL_HOSTS` fixture list does NOT contain (unlike
 * `mcp.example.com`), so the host blocklist is actually reached instead of
 * being short-circuited by the operator-trusted-host exemption.
 */
const UNTRUSTED_SERVER_URL = "https://internal-mcp.invalid/mcp/v1";

/** Public (unblocked) address the injected resolver returns for fixtures. */
const PUBLIC_IP = "93.184.216.34";

function spec(url: string = SERVER_URL): IntegrationSpawnSpec {
  return {
    integrationId: "@vendor/remote",
    namespace: "remote",
    connection: CONN_A,
    sourceKind: "remote",
    manifest: { name: "remote", version: "1.0.0", server: { url, transport: "streamable-http" } },
    toolAllowlist: [],
  } as unknown as IntegrationSpawnSpec;
}

function wire(
  auths: Array<{ authKey: string; authType: string }>,
  deliveryPlans: Record<
    string,
    {
      headerName: string;
      headerPrefix: string;
      value: string;
      allowServerOverride?: boolean;
    }
  >,
  authorizedUris: string[] = ["https://mcp.example.com/**", "https://internal-mcp.invalid/**"],
): IntegrationCredentialsWire {
  return {
    auths: auths.map((a) => ({
      ...a,
      fields: {},
      authorizedUris,
    })),
    deliveryPlans: Object.fromEntries(
      Object.entries(deliveryPlans).map(([k, p]) => [
        k,
        { ...p, allowServerOverride: p.allowServerOverride === true },
      ]),
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
  let successReports = 0;
  const source = {
    snapshot: () => initial,
    refreshOnUnauthorized: async (_authKey: string) => {
      refreshCalls += 1;
      return refresh();
    },
    reportUpstreamSuccess: () => {
      successReports += 1;
    },
  } as unknown as IntegrationCredentialsSource;
  const deps: ConnectRemoteHttpDeps = {
    createClient: (async (_url: string | URL, opts: { fetch?: typeof fetch }) => {
      captured = opts.fetch;
      return {} as AppstrateMcpClient;
    }) as unknown as ConnectRemoteHttpDeps["createClient"],
    resolveHost,
  };
  return {
    deps,
    source,
    getFetch: () => captured!,
    getRefreshCalls: () => refreshCalls,
    getSuccessReports: () => successReports,
  };
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

  it("reports a 2xx on the injected credential, never one on a caller override", async () => {
    const initial = wire([{ authKey: "apikey", authType: "api_key" }], {
      apikey: {
        headerName: "X-Api-Key",
        headerPrefix: "",
        value: "K",
        allowServerOverride: true,
      },
    });
    const { deps, source, getFetch, getSuccessReports } = makeDeps(initial, async () => false);
    await connectRemoteHttpIntegration(spec(), source, deps);

    await withGlobalFetch(
      (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      async () => {
        await getFetch()(SERVER_URL, { method: "POST" });
        await getFetch()(SERVER_URL, { method: "POST", headers: { "x-api-key": "CALLER" } });
      },
    );
    expect(getSuccessReports()).toBe(1);
  });

  it("reports a 2xx only from the origin the credential was sent to, not past a cross-origin redirect", async () => {
    const initial = wire([{ authKey: "apikey", authType: "api_key" }], {
      apikey: { headerName: "X-Api-Key", headerPrefix: "", value: "K" },
    });
    const { deps, source, getFetch, getSuccessReports } = makeDeps(initial, async () => false);
    await connectRemoteHttpIntegration(spec(), source, deps);

    const redirectingTo = (location: string) =>
      (async (input: string) =>
        new URL(input).pathname === "/mcp/v1"
          ? new Response(null, { status: 307, headers: { location } })
          : new Response("{}", { status: 200 })) as unknown as typeof fetch;

    await withGlobalFetch(redirectingTo("https://elsewhere.example.org/landing"), async () => {
      expect((await getFetch()(SERVER_URL, { method: "POST" })).status).toBe(200);
    });
    expect(getSuccessReports()).toBe(0);

    await withGlobalFetch(redirectingTo("/mcp/v2"), async () => {
      expect((await getFetch()(SERVER_URL, { method: "POST" })).status).toBe(200);
    });
    expect(getSuccessReports()).toBe(1);
  });

  it("judges nothing once a hop stripped the credential, even back on its origin", async () => {
    const initial = wire([{ authKey: "apikey", authType: "api_key" }], {
      apikey: { headerName: "X-Api-Key", headerPrefix: "", value: "K" },
    });
    const { deps, source, getFetch, getRefreshCalls, getSuccessReports } = makeDeps(
      initial,
      async () => true,
    );
    await connectRemoteHttpIntegration(spec(), source, deps);

    // A → B (strip) → A/terminal.
    const roundTrip = (terminalStatus: number) =>
      (async (input: string) => {
        const url = new URL(input);
        if (url.pathname === "/mcp/v1") {
          return new Response(null, {
            status: 307,
            headers: { location: "https://elsewhere.example.org/bounce" },
          });
        }
        if (url.pathname === "/bounce") {
          return new Response(null, { status: 307, headers: { location: `${SERVER_URL}/back` } });
        }
        return new Response("{}", { status: terminalStatus });
      }) as unknown as typeof fetch;

    await withGlobalFetch(roundTrip(401), async () => {
      expect((await getFetch()(SERVER_URL, { method: "POST" })).status).toBe(401);
    });
    await withGlobalFetch(roundTrip(200), async () => {
      expect((await getFetch()(SERVER_URL, { method: "POST" })).status).toBe(200);
    });
    expect(getRefreshCalls()).toBe(0);
    expect(getSuccessReports()).toBe(0);
  });

  it("preserves an allowed caller override and does not refresh it on 401", async () => {
    const initial = wire([{ authKey: "oauth", authType: "oauth2" }], {
      oauth: {
        headerName: "Authorization",
        headerPrefix: "Bearer ",
        value: "PLATFORM",
        allowServerOverride: true,
      },
    });
    const { deps, source, getFetch, getRefreshCalls } = makeDeps(initial, async () => true);
    await connectRemoteHttpIntegration(spec(), source, deps);

    let seen: string | null = null;
    const status = await withGlobalFetch(
      (async (_input: unknown, init?: RequestInit) => {
        seen = new Headers(init?.headers).get("Authorization");
        return new Response("{}", { status: 401 });
      }) as unknown as typeof fetch,
      async () =>
        (
          await getFetch()(SERVER_URL, {
            method: "POST",
            headers: { authorization: "Bearer CALLER" },
          })
        ).status,
    );

    expect(seen as string | null).toBe("Bearer CALLER");
    expect(status).toBe(401);
    expect(getRefreshCalls()).toBe(0);
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

  it("never sends a credential outside the authorized URIs of its connection", async () => {
    const initial = wire(
      [{ authKey: "oauth", authType: "oauth2" }],
      { oauth: { headerName: "Authorization", headerPrefix: "Bearer ", value: "TOKEN" } },
      ["https://other.example.com/**"],
    );
    const { deps, source, getFetch } = makeDeps(initial, async () => true);
    await connectRemoteHttpIntegration(spec(), source, deps);

    let fetchCalls = 0;
    await withGlobalFetch(
      (async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
      async () => {
        await expect(getFetch()(SERVER_URL, { method: "POST" })).rejects.toThrow(
          /outside the authorized URIs/,
        );
      },
    );
    expect(fetchCalls).toBe(0);
  });

  // A reconnect to another upstream mid-run: the refreshed snapshot carries that upstream's
  // credential and URIs, while the transport still targets the server rendered at spawn.
  it("refuses the retry when the refreshed credential is for another upstream", async () => {
    const initial = wire([{ authKey: "oauth", authType: "oauth2" }], {
      oauth: { headerName: "Authorization", headerPrefix: "Bearer ", value: "TOKEN" },
    });
    const reconnected = wire(
      [{ authKey: "oauth", authType: "oauth2" }],
      { oauth: { headerName: "Authorization", headerPrefix: "Bearer ", value: "OTHER" } },
      ["https://other.example.com/**"],
    );
    const { deps, source, getFetch } = makeDeps(initial, async () => {
      Object.assign(initial, reconnected);
      return true;
    });
    await connectRemoteHttpIntegration(spec(), source, deps);

    const seen: Array<string | null> = [];
    await withGlobalFetch(
      (async (_input: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return new Response("{}", { status: 401 });
      }) as unknown as typeof fetch,
      async () => {
        await expect(getFetch()(SERVER_URL, { method: "POST" })).rejects.toThrow(
          /outside the authorized URIs/,
        );
      },
    );
    expect(seen).toEqual(["Bearer TOKEN"]);
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
    await connectRemoteHttpIntegration(spec(UNTRUSTED_SERVER_URL), source, deps);

    let fetchCalls = 0;
    await withGlobalFetch(
      (async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
      async () => {
        await expect(getFetch()(UNTRUSTED_SERVER_URL, { method: "POST" })).rejects.toThrow(
          /SSRF guard blocked outbound request/,
        );
      },
    );
    expect(fetchCalls).toBe(0); // fail-closed — the stubbed network layer was never reached
  });

  /**
   * The operator-trusted-host exemption itself — the half of the guard that
   * says YES. `sidecar-env.ts` forwards `EGRESS_ALLOW_INTERNAL_HOSTS` so a
   * host the platform already vouched for is not re-blocked in-run; without
   * a test for it, `isOperatorTrustedEgressHost` could return `false` for
   * everything and the whole suite would stay green while every operator
   * allowlist silently stopped working in production.
   *
   * Both halves share ONE resolver returning ONE private address, so the
   * allowlist is the only variable between them: the exempted host is
   * permitted where the other is blocked. Either half alone proves nothing —
   * the first passes if the guard is off entirely, the second if the
   * exemption never fires.
   *
   * `ssrf.ts` snapshots the env into a module-level Set at IMPORT time, so a
   * test cannot vary the list at run time; the list is the preload's fixture
   * one. The precondition asserts state that dependency out loud rather than
   * leaving the coupling implicit.
   */
  describe("operator-trusted host exemption", () => {
    const bearerWire = () =>
      wire([{ authKey: "oauth", authType: "oauth2" }], {
        oauth: { headerName: "Authorization", headerPrefix: "Bearer ", value: "TOKEN" },
      });
    /** Same private address for both halves — only the hostname differs. */
    const resolvesPrivate = async () => ["10.0.0.5"];

    it("permits an allowlisted host that resolves to a private address", async () => {
      expect(isOperatorTrustedEgressHost("mcp.example.com")).toBe(true);

      const { deps, source, getFetch } = makeDeps(bearerWire(), async () => true, resolvesPrivate);
      await connectRemoteHttpIntegration(spec(), source, deps);

      let fetchCalls = 0;
      const status = await withGlobalFetch(
        (async () => {
          fetchCalls += 1;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
        async () => (await getFetch()(SERVER_URL, { method: "POST" })).status,
      );

      expect(status).toBe(200); // exempted — the private address never blocked it
      expect(fetchCalls).toBe(1);
    });

    it("still blocks a non-allowlisted host resolving to the same private address", async () => {
      expect(isOperatorTrustedEgressHost("internal-mcp.invalid")).toBe(false);

      const { deps, source, getFetch } = makeDeps(bearerWire(), async () => true, resolvesPrivate);
      await connectRemoteHttpIntegration(spec(UNTRUSTED_SERVER_URL), source, deps);

      await withGlobalFetch(
        (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
        async () => {
          await expect(getFetch()(UNTRUSTED_SERVER_URL, { method: "POST" })).rejects.toThrow(
            /SSRF guard blocked outbound request/,
          );
        },
      );
    });
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
      connection: CONN_A,
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

  /**
   * AFPS §7.1 makes `source.remote.transport` a required enum, so an absent
   * value is not a legacy manifest to tolerate — it is a spec the platform
   * cannot have produced. It must fail as loudly as any unknown value.
   */
  it.each([
    ["absent", undefined],
    ["unsupported", "websocket"],
  ])("throws when server.transport is %s", async (_label, transport) => {
    const bad = {
      integrationId: "@vendor/remote",
      namespace: "remote",
      connection: CONN_A,
      sourceKind: "remote",
      manifest: {
        name: "remote",
        version: "1.0.0",
        server: { url: SERVER_URL, ...(transport === undefined ? {} : { transport }) },
      },
      toolAllowlist: [],
    } as unknown as IntegrationSpawnSpec;
    const initial = wire([{ authKey: "oauth", authType: "oauth2" }], {
      oauth: { headerName: "Authorization", headerPrefix: "Bearer ", value: "T" },
    });
    const { deps, source } = makeDeps(initial, async () => true);
    await expect(connectRemoteHttpIntegration(bad, source, deps)).rejects.toThrow(
      /unsupported source\.remote\.transport.*allowed: "streamable-http" \| "sse"/,
    );
  });
});
