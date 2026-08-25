// SPDX-License-Identifier: Apache-2.0

/**
 * The `/llm/*` route for an ALIASED run: the surface is narrowed to the one
 * inference call the container's protocol makes, and that call is TERMINATED
 * and re-originated rather than proxied. Non-aliased runs keep the verbatim
 * passthrough.
 */

import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import { parseModelSwapEnv } from "../model-swap.ts";

// What an aliased run actually ships: the container speaks `pi-messages`, the
// backing speaks the vendor's protocol, and the catalog to rebuild the backing's
// pi model rides on the same private descriptor.
const SWAP = {
  alias: "appstrate-medium",
  real: "deepseek-chat",
  clientApiShape: "pi-messages" as const,
  backingApiShape: "openai-completions" as const,
  backing: { providerId: "deepseek", reasoning: false, input: ["text"] },
};

function makeDeps(fetchFn: typeof fetch): AppDeps {
  return {
    config: {
      platformApiUrl: "http://mock:3000",
      runToken: "tok",
      proxyUrl: "",
      llm: {
        authMode: "api_key",
        baseUrl: "https://api.deepseek.com",
        apiKey: "real-key",
        placeholder: "sk-placeholder",
        modelSwap: SWAP,
      },
    },
    cookieJar: new Map(),
    fetchFn,
    isReady: () => true,
  };
}

describe("/llm/* upstream failure (no alias)", () => {
  it("keeps the upstream hostname in a fetch-level 502 when NO swap is configured", async () => {
    const fetchFn = mock(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ConnectionRefused" });
    }) as unknown as typeof fetch;

    const deps = makeDeps(fetchFn);
    delete (deps.config.llm as { modelSwap?: unknown }).modelSwap;
    const app = createApp(deps);
    const res = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium", messages: [] }),
    });
    expect(res.status).toBe(502);
    const text = await res.text();
    // No alias to protect — the hostname keeps its debugging value.
    expect(text).toContain("ConnectionRefused");
    expect(text).toContain("api.deepseek.com");
  });
});

/**
 * `/llm/*` used to be a total passthrough — any method, any path, recomposed
 * onto the real upstream base URL with the real credential injected. For an
 * ALIASED run that hands an adversarial agent the vendor's own catalogue over
 * `GET /v1/models`. An aliased run now reaches exactly one endpoint.
 */
describe("/llm/* alias surface restriction", () => {
  /** Upstream that fails the test if it is ever reached. */
  function refusingFetch(): { fetchFn: typeof fetch; calls: () => number } {
    let calls = 0;
    const fetchFn = mock(async () => {
      calls += 1;
      return new Response('{"data":[{"id":"deepseek-chat"}]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetchFn, calls: () => calls };
  }

  it("refuses a vendor catalogue read and never reaches upstream", async () => {
    const { fetchFn, calls } = refusingFetch();
    const app = createApp(makeDeps(fetchFn));

    const res = await app.request("/llm/v1/models", { method: "GET" });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    // The refusal is the SAME neutral envelope every other alias refusal uses —
    // a distinct shape would itself be a signal worth probing for.
    const body = JSON.parse(await res.text());
    expect(body).toMatchObject({
      type: "error",
      error: { type: "upstream_error" },
    });
    expect(body.error.message).toContain("appstrate-medium");
    expect(JSON.stringify(body)).not.toContain("deepseek");
    // Refused BEFORE the fetch, so the real credential was never spent on it.
    expect(calls()).toBe(0);
  });

  it("refuses a non-inference method on the inference path", async () => {
    const { fetchFn, calls } = refusingFetch();
    const app = createApp(makeDeps(fetchFn));

    const res = await app.request("/llm/messages", { method: "GET" });

    expect(res.status).toBe(404);
    expect(calls()).toBe(0);
  });

  it("refuses a sibling endpoint of the inference path (path is exact, not a prefix)", async () => {
    const { fetchFn, calls } = refusingFetch();
    const app = createApp(makeDeps(fetchFn));

    const res = await app.request("/llm/messages/extra", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium" }),
    });

    expect(res.status).toBe(404);
    expect(calls()).toBe(0);
  });

  it("keeps the verbatim passthrough for a NON-aliased run", async () => {
    // No alias means no opacity contract: the run's whole point is reaching the
    // provider it was configured with, so the surface stays wide open.
    let seenUrl = "";
    const fetchFn = mock(async (url: string) => {
      seenUrl = url;
      return new Response('{"data":[{"id":"deepseek-chat"}]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const deps = makeDeps(fetchFn);
    delete (deps.config.llm as { modelSwap?: unknown }).modelSwap;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/models", { method: "GET" });

    expect(res.status).toBe(200);
    expect(seenUrl).toBe("https://api.deepseek.com/v1/models");
    expect(await res.text()).toContain("deepseek-chat");
  });
});

/**
 * The route-level join for an ALIASED run: `/llm/messages` must reach the
 * `pi-messages` backend, and every other path must still be refused. Getting
 * this wrong in either direction is invisible in the unit tests on each side:
 * conflating the two shapes either refuses every aliased run or re-opens the
 * passthrough.
 */
describe("/llm/* re-origination routing (aliased run)", () => {
  function reoriginatingDeps(fetchFn: typeof fetch): AppDeps {
    const deps = makeDeps(fetchFn);
    if (deps.config.llm?.authMode !== "api_key") throw new Error("expected api_key llm");
    // pi-ai fetches through `globalThis.fetch`, not the injected `fetchFn`, so
    // the backing URL must be unreachable or this suite would egress for real.
    // `.invalid` is the reserved never-resolving TLD (RFC 2606) — a loopback
    // address would instead be refused by the `/llm/*` SSRF floor (403) before
    // the alias branch this test is about is ever reached.
    deps.config.llm.baseUrl = "https://alias-backing.invalid";
    return deps;
  }

  it("terminates POST /llm/messages instead of proxying it", async () => {
    // The upstream fetch is what the PROXY path would make. The re-origination
    // hands pi-ai its own transport (a status probe over `globalThis.fetch`),
    // so this stub firing at all would mean the request took a proxy branch.
    const fetchFn = mock(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const app = createApp(reoriginatingDeps(fetchFn));

    const res = await app.request("/llm/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "appstrate-medium",
        context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
        options: {},
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    // pi-ai reports the refused connection as an error EVENT, so reaching a
    // well-formed terminal frame at all proves the backend ran the stream.
    const frames = body
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>);
    expect(frames).toHaveLength(1);
    expect(frames[0]!["type"]).toBe("error");
    // The neutral envelope — pi-ai's own prose interpolates the provider. The
    // status is the sidecar's own 502: nothing upstream ever answered, so there
    // is no backing status to report and "unreachable" is what it was.
    expect(frames[0]!["errorMessage"]).toBe(
      'Upstream model error (model "appstrate-medium", status 502)',
    );
    expect(body).not.toContain("deepseek");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("still refuses every other path, including the BACKING's inference path", async () => {
    const fetchFn = mock(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const app = createApp(reoriginatingDeps(fetchFn));

    for (const [method, path] of [
      // What the backing speaks. Keying the allowlist on `backingApiShape`
      // would have allowed this and refused `/messages` — the exact inversion.
      ["POST", "/llm/chat/completions"],
      ["GET", "/llm/v1/models"],
      ["POST", "/llm/v1/messages"],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
      });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("drives the allowlist from the descriptor as it arrives over PI_MODEL_SWAP_JSON", async () => {
    // Ties the boot-time boundary to the request-time enforcement: the swap the
    // sidecar actually runs on is whatever `parseModelSwapEnv` returned, so the
    // allowed path must follow the `clientApiShape` that crossed the env var.
    const fetchFn = mock(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const deps = reoriginatingDeps(fetchFn);
    if (deps.config.llm?.authMode !== "api_key") throw new Error("expected api_key llm");
    deps.config.llm.modelSwap = parseModelSwapEnv(JSON.stringify(SWAP));
    const app = createApp(deps);

    const allowed = await app.request("/llm/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "appstrate-medium",
        context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
        options: {},
      }),
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toBe("text/event-stream");

    expect((await app.request("/llm/v1/models", { method: "GET" })).status).toBe(404);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
