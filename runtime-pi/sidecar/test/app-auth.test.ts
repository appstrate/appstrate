// SPDX-License-Identifier: Apache-2.0

/**
 * Inbound authentication on the sidecar's control surface.
 *
 * The threat this closes: the per-run Docker network is NOT a boundary between
 * the agent and its siblings. `integration-runtime-adapter-docker.ts` attaches
 * every third-party integration runner to `appstrate-exec-<runId>` and hands it
 * `http://sidecar:<port>`, so before this middleware a `source.kind: "local"`
 * integration could `curl` the LLM proxy and spend the org's provider
 * credential — unauthenticated and unattributed. `--internal` blocks egress,
 * not sibling-to-sibling traffic.
 *
 * Written against the real, UNWRAPPED `createApp`: the sibling suites go
 * through `helpers/authed-app.ts`, which stamps the header for them, so this is
 * the only file that can actually make the gate pass or fail.
 *
 * Every negative here sits next to the positive control that differs from it by
 * ONE thing — the header — so a route that started answering 401 for an
 * unrelated reason (missing config, bad Host, wrong body) cannot be mistaken
 * for the gate working.
 */

import { describe, it, expect, mock } from "bun:test";
import { SIDECAR_AUTH_HEADER } from "@appstrate/core/sidecar-types";
import { createApp, type AppDeps } from "../app.ts";
import { RuntimeEventJournal } from "../runtime-event-journal.ts";

const TOKEN = "s3cr3t-agent-token";
/** Same LENGTH as {@link TOKEN} — the comparison must not pass on length alone. */
const WRONG_TOKEN = "s3cr3t-agent-tokeX";

function makeDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: {
      platformApiUrl: "http://mock:3000",
      runToken: "run-token-never-leaves-the-platform",
      sidecarAuthToken: TOKEN,
      proxyUrl: "",
      llm: {
        authMode: "api_key",
        baseUrl: "https://api.anthropic.com",
        apiKey: "real-sk-ant-key",
        placeholder: "sk-placeholder",
      },
    },
    cookieJar: new Map(),
    fetchFn: mock(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch,
    isReady: () => true,
    runtimeEventJournal: new RuntimeEventJournal(),
    ...overrides,
  };
}

/**
 * One entry per agent-facing route, each with the request shape that SUCCEEDS
 * when the token is right. `Host` is present where the route also runs the
 * DNS-rebinding check, so the only variable left across the three cases is the
 * auth header.
 */
const PROTECTED_ROUTES = [
  {
    name: "ALL /llm/*",
    path: "/llm/v1/messages",
    init: { method: "POST", headers: { "Content-Type": "application/json" } } as RequestInit,
  },
  {
    name: "GET /integrations/boot-report",
    path: "/integrations/boot-report",
    init: {} as RequestInit,
  },
  {
    name: "GET /runtime-events",
    path: "/runtime-events?after=0",
    init: { headers: { Host: "sidecar" } } as RequestInit,
  },
  {
    name: "ALL /mcp",
    path: "/mcp",
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Host: "sidecar",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    } as RequestInit,
  },
] as const;

/** Merge the auth header into a route's fixed init without mutating it. */
function withToken(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(SIDECAR_AUTH_HEADER, token);
  return { ...init, headers };
}

describe("sidecar control surface — agent authentication", () => {
  for (const route of PROTECTED_ROUTES) {
    describe(route.name, () => {
      it("refuses a request carrying no token", async () => {
        const app = createApp(makeDeps());
        const res = await app.request(route.path, route.init);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      });

      it("refuses a request carrying the wrong token", async () => {
        const app = createApp(makeDeps());
        const res = await app.request(route.path, withToken(route.init, WRONG_TOKEN));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      });

      it("passes a request carrying the right token through to the handler", async () => {
        const app = createApp(makeDeps());
        const res = await app.request(route.path, withToken(route.init, TOKEN));
        // The positive control: same request, same deps, right token. Anything
        // other than 401 proves the middleware handed off — the handler's own
        // status is that route's business, asserted in its own suite.
        expect(res.status).not.toBe(401);
        expect(res.status).toBe(200);
      });
    });
  }

  it("keeps /health open — it is the container health gate, probed before the run exists", async () => {
    const ready = await createApp(makeDeps()).request("/health");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok" });

    // The degraded answer is unauthenticated too: an orchestrator that had to
    // present a token to learn the container is not ready could not act on it.
    const degraded = await createApp(makeDeps({ isReady: () => false })).request("/health");
    expect(degraded.status).toBe(503);
  });

  it("denies by default: a sidecar with NO configured token authenticates nobody", async () => {
    // A sidecar that was never handed a token cannot tell the agent from the
    // integration runners on its network, so it must answer neither. The
    // control is the identical request against a CONFIGURED sidecar.
    const depsWithoutToken = makeDeps();
    delete depsWithoutToken.config.sidecarAuthToken;
    const app = createApp(depsWithoutToken);

    for (const route of PROTECTED_ROUTES) {
      // Even presenting the token the OTHER sidecar would accept.
      const res = await app.request(route.path, withToken(route.init, TOKEN));
      expect(res.status).toBe(401);
    }
    // Control: the same routes on a configured sidecar answer 200.
    const configured = createApp(makeDeps());
    for (const route of PROTECTED_ROUTES) {
      const res = await configured.request(route.path, withToken(route.init, TOKEN));
      expect(res.status).toBe(200);
    }
    // …and /health stays up on the unconfigured one — an unauthenticatable
    // sidecar is still a container the orchestrator has to be able to probe.
    expect((await app.request("/health")).status).toBe(200);
  });

  it("never forwards the token upstream on the /llm/* passthrough", async () => {
    // The token is a live secret and the upstream is a third party. It reaches
    // `filterHeaders`' skip set for the same reason `x-appstrate-pi-sdk` does.
    let forwarded: Headers | undefined;
    const fetchFn = mock(async (_url: string, init: RequestInit) => {
      forwarded = new Headers(init.headers);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const app = createApp(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set(SIDECAR_AUTH_HEADER, TOKEN);
    // A header the proxy IS supposed to forward, so the assertion below is
    // about this one header and not about the filter dropping everything.
    headers.set("anthropic-version", "2023-06-01");
    const res = await app.request("/llm/v1/messages", { method: "POST", headers });

    expect(res.status).toBe(200);
    expect(forwarded?.get("anthropic-version")).toBe("2023-06-01");
    expect(forwarded?.get(SIDECAR_AUTH_HEADER)).toBeNull();
  });
});
