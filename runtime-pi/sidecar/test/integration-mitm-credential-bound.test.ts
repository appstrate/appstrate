// SPDX-License-Identifier: Apache-2.0

/**
 * The MITM listener injects a credential only under an allowlist naming its hosts — the rule
 * the three api_call paths apply (`credentialUrlPolicy`), re-checked at run time for manifests
 * published before the write-path check. `handleInnerRequest` is driven directly.
 */

import { describe, it, expect } from "bun:test";
import {
  handleInnerRequest,
  type MitmCredentialSource,
  type MitmListenerEvent,
} from "../integration-mitm-listener.ts";

const allowAll = { allowsUrl: () => true };

function source(authorizedUris: string[]): MitmCredentialSource {
  return {
    current: () => ({
      auths: [{ authKey: "api", authType: "api_key", fields: { api_key: "k" }, authorizedUris }],
    }),
    deliveryPlans: () => ({
      api: { headerName: "X-Api-Key", headerPrefix: "", value: "k", allowServerOverride: false },
    }),
  };
}

async function send(authorizedUris: string[]) {
  const sent: Headers[] = [];
  const events: MitmListenerEvent[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response("ok");
  }) as unknown as typeof fetch;
  const res = await handleInnerRequest(
    new Request("https://127.0.0.1/v1/things"),
    "attacker.example",
    source(authorizedUris),
    fetchFn,
    1024,
    (e) => events.push(e),
    allowAll,
  );
  return { res, sent, events };
}

describe("MITM listener — injected credential needs a host-bounded allowlist", () => {
  it("refuses to inject under a host-unbounded pattern", async () => {
    const { res, sent, events } = await send(["https://**"]);
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
    expect(events).toContainEqual({
      kind: "request-refused",
      url: "https://attacker.example/v1/things",
      reason: "credential not host-bounded",
    });
  });

  it("refuses the connect re-login replay once it would inject", async () => {
    let session = ""; // not acquired yet: the first attempt injects nothing
    const src: MitmCredentialSource = {
      current: () => ({
        auths: [{ authKey: "s", authType: "custom", fields: {}, authorizedUris: ["https://**"] }],
      }),
      deliveryPlans: () => ({
        s: {
          headerName: "Cookie",
          headerPrefix: "sid=",
          value: session,
          allowServerOverride: false,
        },
      }),
      shouldReauth: (_key, status) => status === 401,
      hasReloginHandler: () => true,
      refreshOnUnauthorized: async () => {
        session = "fresh";
        return true;
      },
    };
    const sent: Headers[] = [];
    const events: MitmListenerEvent[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return new Response("no", { status: 401 });
    }) as unknown as typeof fetch;
    const res = await handleInnerRequest(
      new Request("https://127.0.0.1/v1/things"),
      "attacker.example",
      src,
      fetchFn,
      1024,
      (e) => events.push(e),
      allowAll,
    );
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get("cookie")).toBeNull();
    expect(events).toContainEqual({
      kind: "request-refused",
      url: "https://attacker.example/v1/things",
      reason: "credential not host-bounded",
    });
  });

  it("refuses to substitute a login secret under a host-unbounded envelope", async () => {
    const src: MitmCredentialSource = {
      current: () => ({ auths: [] }),
      deliveryPlans: () => ({}),
      activeInputs: () => ({
        inputs: { password: "pw" },
        authorizedUris: ["https://attacker.example/**", "https://**"],
      }),
    };
    const events: MitmListenerEvent[] = [];
    let fetched = 0;
    const res = await handleInnerRequest(
      new Request("https://127.0.0.1/login", { headers: { "x-pw": "{{password}}" } }),
      "attacker.example",
      src,
      (async () => {
        fetched += 1;
        return new Response("ok");
      }) as unknown as typeof fetch,
      1024,
      (e) => events.push(e),
      allowAll,
    );
    expect(res.status).toBe(403);
    expect(fetched).toBe(0);
    expect(events).toContainEqual({
      kind: "request-refused",
      url: "https://attacker.example/login",
      reason: "credential not host-bounded",
    });
  });

  it("forwards a request carrying no login placeholder under the same envelope", async () => {
    const src: MitmCredentialSource = {
      current: () => ({ auths: [] }),
      deliveryPlans: () => ({}),
      activeInputs: () => ({
        inputs: { password: "pw" },
        authorizedUris: ["https://attacker.example/**", "https://**"],
      }),
    };
    let fetched = 0;
    const res = await handleInnerRequest(
      new Request("https://127.0.0.1/login"),
      "attacker.example",
      src,
      (async () => {
        fetched += 1;
        return new Response("ok");
      }) as unknown as typeof fetch,
      1024,
      () => {},
      allowAll,
    );
    expect(res.status).toBe(200);
    expect(fetched).toBe(1);
  });

  it("injects under an allowlist naming the host", async () => {
    const { res, sent } = await send(["https://attacker.example/**"]);
    expect(res.status).toBe(200);
    expect(sent[0]!.get("x-api-key")).toBe("k");
  });
});

describe("MITM listener — no value reaches a response or an event", () => {
  const SECRET = "SECRETVALUE123";
  const okFetch = (async () => new Response("ok")) as unknown as typeof fetch;

  function keySource(value: string): MitmCredentialSource {
    return {
      current: () => ({
        auths: [
          {
            authKey: "api",
            authType: "api_key",
            fields: { api_key: value },
            authorizedUris: ["https://api.example/**"],
          },
        ],
      }),
      deliveryPlans: () => ({
        api: { headerName: "X-Api-Key", headerPrefix: "", value, allowServerOverride: false },
      }),
    };
  }

  function loginSource(password: string): MitmCredentialSource {
    return {
      current: () => ({ auths: [] }),
      deliveryPlans: () => ({}),
      activeInputs: () => ({ inputs: { password }, authorizedUris: ["https://api.example/**"] }),
    };
  }

  async function run(src: MitmCredentialSource, req: Request, fetchFn = okFetch) {
    let fetched = 0;
    const events: MitmListenerEvent[] = [];
    const res = await handleInnerRequest(
      req,
      "api.example",
      src,
      (async (...args: Parameters<typeof fetch>) => {
        fetched += 1;
        return fetchFn(...args);
      }) as typeof fetch,
      1 << 20,
      (e) => events.push(e),
      allowAll,
    );
    const body = await res.text();
    expect(body).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    return { res, body, events, fetched };
  }

  // `Headers.set` threw a TypeError quoting the value, out of any try: Bun's dev error page.
  for (const suffix of ["\r\nX-Evil: 1", "​", "\u0000"]) {
    it(`refuses an injected credential ending ${JSON.stringify(suffix)} with a fixed 403`, async () => {
      const { res, body, events, fetched } = await run(
        keySource(SECRET + suffix),
        new Request("https://127.0.0.1/v1/x"),
      );
      expect(res.status).toBe(403);
      expect(body).toBe("MITM listener: credential is not a valid header value");
      expect(fetched).toBe(0);
      expect(events).toContainEqual({
        kind: "request-refused",
        url: "https://api.example/v1/x",
        reason: "credential is not a valid header value",
      });
    });
  }

  it("refuses a login input substituted into a header it cannot be in", async () => {
    const { res, fetched } = await run(
      loginSource(`${SECRET}€`),
      new Request("https://127.0.0.1/login", { headers: { "x-pw": "{{password}}" } }),
    );
    expect(res.status).toBe(403);
    expect(fetched).toBe(0);
  });

  it("names the path before login substitution and no query in its events", async () => {
    const { res, events } = await run(
      loginSource(SECRET),
      new Request("https://127.0.0.1/login/{{password}}?q={{password}}&t=abc"),
    );
    expect(res.status).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "request-forwarded",
        url: "https://api.example/login/%7B%7Bpassword%7D%7D",
      }),
    );
  });

  it("answers an upstream failure with a fixed 502, the event naming its class only", async () => {
    const { res, body, events } = await run(
      keySource("k"),
      new Request("https://127.0.0.1/v1/x?token=abc"),
      (async () => {
        throw Object.assign(new Error(`connect failed https://api.example/v1/x?pw=${SECRET}`), {
          code: "ECONNREFUSED",
        });
      }) as unknown as typeof fetch,
    );
    expect(res.status).toBe(502);
    expect(body).toBe("MITM listener: upstream request failed");
    expect(events).toContainEqual({
      kind: "upstream-error",
      url: "https://api.example/v1/x",
      error: "Error (ECONNREFUSED)",
    });
  });

  it("answers any other throw with a fixed 500, the event naming its class only", async () => {
    const { res, body, events } = await run(
      {
        current: () => {
          throw new TypeError(`Header 'x' has invalid value: '${SECRET}'`);
        },
        deliveryPlans: () => ({}),
      },
      new Request("https://127.0.0.1/v1/x"),
    );
    expect(res.status).toBe(500);
    expect(body).toBe("MITM listener: internal error");
    expect(events).toEqual([
      { kind: "internal-error", url: "https://api.example/v1/x", error: "TypeError" },
    ]);
  });
});
