// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `createMcpHttpClient` + `wrapClient`. The HTTP transport is
 * exercised against a Hono app running an `WebStandardStreamableHTTPServerTransport`
 * — this is the exact same shape the sidecar mounts in production, so
 * any regression here is also a regression at the sidecar boundary.
 *
 * The `wrapClient` surface (cancellation + timeout threading) is
 * exercised against the in-process pair, which uses `InMemoryTransport`
 * — no fetch, no port — making cancellation deterministic to test.
 */

import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createInProcessPair,
  createMcpHttpClient,
  createMcpServer,
  wrapClient,
  type AppstrateToolDefinition,
} from "../src/index.ts";

function echoTool(): AppstrateToolDefinition {
  return {
    descriptor: {
      name: "echo",
      description: "Echoes its input.",
      inputSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
    },
    handler: async (args) => ({
      content: [{ type: "text", text: String(args.msg ?? "") }],
    }),
  };
}

function slowTool(): AppstrateToolDefinition {
  return {
    descriptor: {
      name: "slow",
      description: "Sleeps until aborted or 5s elapses.",
      inputSchema: { type: "object" },
    },
    handler: async (_args, extra) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 5000);
        extra.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
      return { content: [{ type: "text", text: "done" }] };
    },
  };
}

/**
 * Build a fetch shim that mounts a sidecar-shaped /mcp endpoint without
 * pulling in Hono — the test code path is identical: Request in,
 * Response out, fresh transport per request to satisfy the SDK's
 * stateless-mode invariant.
 */
function mountStandalone(tools: AppstrateToolDefinition[]): {
  fetch: typeof fetch;
  url: URL;
} {
  const handler = async (request: Request): Promise<Response> => {
    const server = createMcpServer(tools, { name: "test", version: "0.0.0" });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: false,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
      await server.close();
    }
  };

  const fetcher: typeof fetch = ((req: Request | string | URL, init?: RequestInit) => {
    const request = req instanceof Request ? req : new Request(req as string, init);
    return handler(request);
  }) as typeof fetch;

  return { fetch: fetcher, url: new URL("http://test.invalid/mcp") };
}

describe("createMcpHttpClient", () => {
  it("connects to a sidecar /mcp and lists tools", async () => {
    const { fetch: fetcher, url } = mountStandalone([echoTool()]);
    const client = await createMcpHttpClient(url, { fetch: fetcher });
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("echo");
    } finally {
      await client.close();
    }
  });

  it("calls a tool and surfaces the result", async () => {
    const { fetch: fetcher, url } = mountStandalone([echoTool()]);
    const client = await createMcpHttpClient(url, { fetch: fetcher });
    try {
      const res = await client.callTool({ name: "echo", arguments: { msg: "hi" } });
      expect(res.content).toEqual([{ type: "text", text: "hi" }]);
    } finally {
      await client.close();
    }
  });

  it("threads bearerToken through Authorization header", async () => {
    const observed: { auth: string | null } = { auth: null };
    const { url } = mountStandalone([echoTool()]);
    const observingFetch: typeof fetch = ((req: Request | string | URL, init?: RequestInit) => {
      const request = req instanceof Request ? req : new Request(req as string, init);
      observed.auth = request.headers.get("authorization");
      // Fail the network — we only care about the header observation. The
      // SDK throws on the connect failure, which is fine: we caught the
      // header before the error propagates.
      return Promise.reject(new Error("intercepted"));
    }) as typeof fetch;

    let caught: unknown;
    try {
      await createMcpHttpClient(url, { fetch: observingFetch, bearerToken: "secret-token" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(observed.auth).toBe("Bearer secret-token");
  });

  it("close() is idempotent and tears down the transport", async () => {
    const { fetch: fetcher, url } = mountStandalone([echoTool()]);
    const client = await createMcpHttpClient(url, { fetch: fetcher });
    await client.close();
    // Second call is a no-op.
    await client.close();
    let caught: unknown;
    try {
      await client.listTools();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});

/**
 * `options.signal` used to be read ONLY inside `connectWithRetry`, so the
 * single-shot path — the one every in-process caller takes, chat included —
 * ignored it outright. A wedged server then held the handshake for the SDK's
 * full 60 s `DEFAULT_REQUEST_TIMEOUT_MSEC` with the caller's own deadline and
 * its stop button both inert, and the caller had no way to tell it was stuck.
 *
 * Each case below gets its own short timeout: on the unfixed code they do not
 * fail, they HANG, and a suite-length wedge buries the signal.
 */
describe("createMcpHttpClient — connect cancellation", () => {
  /** A transport that accepts the request and never answers. */
  function wedgedFetch(onRequest?: () => void): typeof fetch {
    return ((_req: Request | string | URL, _init?: RequestInit): Promise<Response> => {
      onRequest?.();
      // No timer: a never-settling promise holds nothing open.
      return new Promise<Response>(() => {});
    }) as typeof fetch;
  }

  it("single-shot: an abort mid-handshake unwinds the connect", async () => {
    const { url } = mountStandalone([echoTool()]);
    const ac = new AbortController();
    let reached = false;
    const connecting = createMcpHttpClient(url, {
      fetch: wedgedFetch(() => {
        reached = true;
      }),
      signal: ac.signal,
    });

    // Abort only once the handshake is genuinely in flight, so this exercises
    // the listener path rather than the `throwIfAborted` fast path below.
    await new Promise((r) => setTimeout(r, 20));
    expect(reached).toBe(true);
    ac.abort(new Error("caller gave up"));

    let caught: unknown;
    try {
      await connecting;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  }, 2_000);

  it("single-shot: an already-aborted signal never opens the handshake", async () => {
    const { url } = mountStandalone([echoTool()]);
    const ac = new AbortController();
    ac.abort(new Error("already gone"));
    let reached = false;

    let caught: unknown;
    try {
      await createMcpHttpClient(url, {
        fetch: wedgedFetch(() => {
          reached = true;
        }),
        signal: ac.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(reached).toBe(false);
  }, 2_000);

  it("retry path: an abort DURING an attempt does not wait the attempt out", async () => {
    // The loop only ever checked `signal.aborted` between attempts, so a
    // handshake that wedges made the retry deadline — not the caller's abort —
    // the effective bound.
    const { url } = mountStandalone([echoTool()]);
    const ac = new AbortController();
    const connecting = createMcpHttpClient(url, {
      fetch: wedgedFetch(),
      signal: ac.signal,
      retry: { deadlineMs: 60_000, baseMs: 1, capMs: 5 },
    });

    await new Promise((r) => setTimeout(r, 20));
    ac.abort(new Error("caller gave up"));

    let caught: unknown;
    try {
      await connecting;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  }, 2_000);
});

/**
 * `client-connect-residual` — the documented gap in {@link connectWithSignal}'s
 * bound, pinned so the docstring cannot drift back into claiming the signal
 * covers the whole connect. `Client.connect` awaits a
 * `notifications/initialized` POST AFTER the options-bounded `initialize`, and
 * the SDK gives that call no options, hence no signal.
 *
 * This asserts CURRENT behaviour, not a fix: it passes before and after. Delete
 * it only together with the residual paragraph it guards.
 */
describe("createMcpHttpClient — client-connect-residual", () => {
  it("does not honour an abort landing after initialize settles", async () => {
    const NOTIFY_DELAY_MS = 200;
    const { fetch: base, url } = mountStandalone([echoTool()]);
    const ac = new AbortController();
    const fetcher: typeof fetch = (async (req: Request | string | URL, init?: RequestInit) => {
      const request = req instanceof Request ? req : new Request(req as string, init);
      if ((await request.clone().text()).includes("notifications/initialized")) {
        // Exactly the window the docstring names: initialize has answered,
        // the notification is in flight, the caller gives up.
        ac.abort(new Error("caller gave up"));
        await new Promise((r) => setTimeout(r, NOTIFY_DELAY_MS));
      }
      return base(request);
    }) as typeof fetch;

    const started = Date.now();
    const client = await createMcpHttpClient(url, { fetch: fetcher, signal: ac.signal });
    // Resolved despite the abort, and only after the POST came back.
    expect(Date.now() - started).toBeGreaterThanOrEqual(NOTIFY_DELAY_MS);
    await client.close();
  }, 5_000);
});

describe("wrapClient — cancellation", () => {
  it("aborts an in-flight call when the AbortSignal fires", async () => {
    const pair = await createInProcessPair([slowTool()]);
    try {
      const ac = new AbortController();
      const promise = pair.client.callTool({ name: "slow" }, undefined, {
        signal: ac.signal,
      });
      // Give the SDK a tick to dispatch.
      await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      let caught: unknown;
      try {
        await promise;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
    } finally {
      await pair.close();
    }
  });

  it("forwards timeoutMs to the SDK", async () => {
    // Using a tiny timeout against the slow tool; the SDK should abort.
    const pair = await createInProcessPair([slowTool()]);
    const wrapped = wrapClient(pair.client, { close: () => Promise.resolve() }, 50);
    try {
      let caught: unknown;
      try {
        await wrapped.callTool({ name: "slow" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
    } finally {
      await pair.close();
    }
  });
});

describe("wrapClient — surface narrowing", () => {
  it("exposes listTools/callTool via the wrapped client", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer([echoTool()]);
    const sdkClient = new Client({ name: "wrap-test", version: "0.0.0" });
    await Promise.all([server.connect(b), sdkClient.connect(a)]);
    const wrapped = wrapClient(sdkClient, { close: () => Promise.resolve() });
    try {
      const { tools } = await wrapped.listTools();
      expect(tools).toHaveLength(1);
      const res = await wrapped.callTool({ name: "echo", arguments: { msg: "ok" } });
      expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    } finally {
      await wrapped.close();
      await server.close();
    }
  });
});

describe("wrapClient — capability discovery", () => {
  it("getServerCapabilities returns the SDK's snapshot after connect", async () => {
    const pair = await createInProcessPair([echoTool()]);
    try {
      const caps = pair.client.getServerCapabilities();
      expect(caps).toBeDefined();
      expect(caps?.tools).toBeDefined();
    } finally {
      await pair.close();
    }
  });

  it("getServerVersion returns the server Implementation info", async () => {
    const pair = await createInProcessPair([echoTool()], {
      serverInfo: { name: "test-server", version: "9.9.9" },
    });
    try {
      const info = pair.client.getServerVersion();
      expect(info).toEqual({ name: "test-server", version: "9.9.9" });
    } finally {
      await pair.close();
    }
  });

  it("AppstrateMcpClient exposes both via the wrapper", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer([echoTool()], { name: "srv", version: "1.2.3" });
    const sdkClient = new Client({ name: "cli", version: "0.0.0" });
    await Promise.all([server.connect(b), sdkClient.connect(a)]);
    const wrapped = wrapClient(sdkClient, { close: () => Promise.resolve() });
    try {
      expect(wrapped.getServerVersion()).toEqual({ name: "srv", version: "1.2.3" });
      expect(wrapped.getServerCapabilities()?.tools).toBeDefined();
    } finally {
      await wrapped.close();
      await server.close();
    }
  });
});
