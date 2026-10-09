// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  runLogin,
  LoginError,
  evaluateSuccessCriteriaForTest,
  type LoginConfig,
} from "../../src/connect/login-engine.ts";

const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");

/** Queue of canned responses; records the requests it received. */
function fakeFetch(
  queue: Array<{ status?: number; body?: string; headers?: Record<string, string> }>,
): { impl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = queue[i++] ?? { status: 200, body: "{}" };
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// The login engine now runs a DNS-aware SSRF host check (`resolveAndCheckHost`)
// before dispatch. Inject a deterministic resolver so test hostnames resolve to
// a fixed PUBLIC address — otherwise a real DNS lookup of `idp.example.com`
// (NXDOMAIN) would fail-close every happy-path test. Numeric-IP tests
// (169.254.169.254) skip the resolver and hit the literal blocklist directly.
const TEST_RESOLVE = async (): Promise<string[]> => ["93.184.216.34"];

const ALLOW = ["https://idp.example.com/**"];

describe("runLogin — declarative login (AFPS)", () => {
  it("password grant: substitutes secrets, extracts token + expiry", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: JSON.stringify({ access_token: "TOK-123", expires_in: 3600 }) },
    ]);
    const config: LoginConfig = {
      login: {
        request: {
          method: "POST",
          url: "https://idp.example.com/token",
          body: "grant_type=password&username={{email}}&password={{password}}",
          content_type: "application/x-www-form-urlencoded",
        },
        outputs: {
          access_token: "$response.body#/access_token",
          expires_in: "$response.body#/expires_in",
        },
        expires_in_output: "expires_in",
      },
    };

    const res = await runLogin(config, {
      inputs: { email: "a@b.co", password: "s3cr3t" },
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
      now: () => 1_000_000,
    });

    expect(res.outputs.access_token).toBe("TOK-123");
    // expiresAt computed from expires_in seconds.
    expect(res.expiresAt).toBe(new Date(1_000_000 + 3600 * 1000).toISOString());
    // The login request received the substituted secret in the body, form-encoded.
    expect(calls[0]!.init.body).toBe("grant_type=password&username=a%40b.co&password=s3cr3t");
  });

  it("non-leak: the bootstrap secret never lands in outputs", async () => {
    const { impl } = fakeFetch([{ status: 200, body: JSON.stringify({ access_token: "TOK" }) }]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token", body: "p={{password}}" },
        outputs: { access_token: "$response.body#/access_token" },
      },
    };
    const res = await runLogin(config, {
      inputs: { password: "s3cr3t" },
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    });
    expect(res.outputs).toEqual({ access_token: "TOK" });
    expect(JSON.stringify(res.outputs)).not.toContain("s3cr3t");
  });

  it("SSRF blocklist applies even under allowAllUris (runs in-process)", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    const config: LoginConfig = {
      login: {
        request: { method: "GET", url: "http://169.254.169.254/latest/meta-data/" },
        outputs: { access_token: "$response.header.x-token" },
      },
    };
    const run = runLogin(config, {
      inputs: {},
      authorizedUris: [],
      allowAllUris: true, // waives the allowlist — must NOT waive the blocklist
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    });
    await expect(run).rejects.toMatchObject({ reason: "url_not_allowed" });
    // Fail-closed: the request never went out.
    expect(calls.length).toBe(0);
  });

  it("rejects a non-http(s) scheme (ftp://) before any DNS resolve or fetch", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    const config: LoginConfig = {
      login: {
        request: { method: "GET", url: "ftp://idp.example.com/token" },
        outputs: { access_token: "$response.header.x-token" },
      },
    };
    const run = runLogin(config, {
      inputs: {},
      authorizedUris: [],
      allowAllUris: true, // scheme floor must hold even with the allowlist waived
      fetchImpl: impl,
      resolveHost: async () => {
        throw new Error("resolver must not run for a scheme-rejected URL");
      },
    });
    await expect(run).rejects.toMatchObject({ reason: "url_not_allowed" });
    // Fail-closed: neither the resolver nor the request ever fired.
    expect(calls.length).toBe(0);
  });

  it("extracts a JWT claim (petitspas-like personId)", async () => {
    const jwt = `${b64url({ alg: "none" })}.${b64url({ AUTH: [{ personId: "P-42" }] })}.`;
    const { impl } = fakeFetch([{ status: 200, body: JSON.stringify({ access_token: jwt }) }]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token", body: "grant=pw" },
        outputs: {
          access_token: "$response.body#/access_token",
          person_id: { from: "jwt", token: "{$credential.access_token}", path: "/AUTH/0/personId" },
        },
        identity_outputs: ["person_id"],
      },
    };
    const res = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    });
    expect(res.outputs.person_id).toBe("P-42");
    expect(res.identityClaims.person_id).toBe("P-42");
  });

  it("resolves a jwt extractor regardless of key order (JSONB reorder safety)", async () => {
    const jwt = `${b64url({ alg: "none" })}.${b64url({ AUTH: [{ personId: "P-7" }] })}.`;
    const { impl } = fakeFetch([{ status: 200, body: JSON.stringify({ access_token: jwt }) }]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token", body: "grant=pw" },
        // `person_id` (jwt) is declared BEFORE `access_token` it depends on —
        // mimics a manifest reordered by JSONB persistence. The engine's
        // two-pass extraction (non-jwt first) must still resolve it.
        outputs: {
          person_id: { from: "jwt", token: "{$credential.access_token}", path: "/AUTH/0/personId" },
          access_token: "$response.body#/access_token",
        },
      },
    };
    const res = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    });
    expect(res.outputs.person_id).toBe("P-7");
  });

  it("fails closed when a declared output extracts an empty value", async () => {
    // Upstream answers 200 but with no Set-Cookie — the cookie extractor yields
    // undefined rather than throwing, so without the empty-guard the engine
    // would silently persist `JSESSIONID=""`. Assert it fails closed instead.
    const { impl } = fakeFetch([{ status: 200, body: "ok" }]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/login", body: "u=x" },
        outputs: { JSESSIONID: { from: "cookie", name: "JSESSIONID" } },
      },
    };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("extract_failed");
  });

  it("captures a Set-Cookie value", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: "ok", headers: { "set-cookie": "JSESSIONID=abc123; Path=/; HttpOnly" } },
    ]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/login", body: "u=x" },
        outputs: { JSESSIONID: { from: "cookie", name: "JSESSIONID" } },
      },
    };
    const res = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    });
    expect(res.outputs.JSESSIONID).toBe("abc123");
  });
});

describe("runLogin — security limits", () => {
  const baseLogin = {
    request: { method: "POST" as const, url: "https://idp.example.com/token", body: "x=1" },
    outputs: { t: "$response.body#/t" },
  };

  it("rejects a URL outside the authorizedUris allowlist", async () => {
    const { impl } = fakeFetch([{ status: 200, body: "{}" }]);
    const config: LoginConfig = {
      login: { ...baseLogin, request: { ...baseLogin.request, url: "https://evil.example.com/x" } },
    };
    await expect(
      runLogin(config, {
        inputs: {},
        authorizedUris: ALLOW,
        allowAllUris: false,
        fetchImpl: impl,
        resolveHost: TEST_RESOLVE,
      }),
    ).rejects.toMatchObject({ reason: "url_not_allowed" });
  });

  it("fails closed on an unresolved placeholder", async () => {
    const { impl } = fakeFetch([{ status: 200, body: "{}" }]);
    const config: LoginConfig = {
      login: { ...baseLogin, request: { ...baseLogin.request, body: "x={{missing}}" } },
    };
    await expect(
      runLogin(config, {
        inputs: {},
        authorizedUris: ALLOW,
        allowAllUris: false,
        fetchImpl: impl,
        resolveHost: TEST_RESOLVE,
      }),
    ).rejects.toMatchObject({ reason: "unresolved_placeholder" });
  });

  it("fails closed on a {$…} expression in the request, before any fetch", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    const config: LoginConfig = {
      login: {
        ...baseLogin,
        request: { ...baseLogin.request, body: "password={$credential.password}" },
      },
    };
    await expect(
      runLogin(config, {
        inputs: { password: "s3cr3t" },
        authorizedUris: ALLOW,
        allowAllUris: false,
        fetchImpl: impl,
        resolveHost: TEST_RESOLVE,
      }),
    ).rejects.toMatchObject({ reason: "invalid_config" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a simple criterion other than <expr> == <operand>, before any fetch", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    const config: LoginConfig = {
      login: { ...baseLogin, success_criteria: [{ condition: "$statusCode != 401" }] },
    };
    await expect(
      runLogin(config, {
        inputs: {},
        authorizedUris: ALLOW,
        allowAllUris: false,
        fetchImpl: impl,
        resolveHost: TEST_RESOLVE,
      }),
    ).rejects.toMatchObject({ reason: "invalid_config" });
    expect(calls).toHaveLength(0);
  });

  it("sends an input value containing {$…} as data, not as an expression", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: JSON.stringify({ t: "x" }) }]);
    const config: LoginConfig = {
      login: { ...baseLogin, request: { ...baseLogin.request, body: "p={{password}}" } },
    };
    await runLogin(config, {
      inputs: { password: "a{$b}c" },
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    });
    expect(calls[0]!.init.body).toBe("p=a{$b}c");
  });

  it("rejects a non-OK status without echoing the body", async () => {
    const { impl } = fakeFetch([{ status: 401, body: "secret-error-detail" }]);
    const config: LoginConfig = { login: baseLogin };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("rejected");
    expect((err as LoginError).upstreamStatus).toBe(401);
    expect((err as Error).message).not.toContain("secret-error-detail");
  });

  it("honors success_criteria ($statusCode == N)", async () => {
    // The login declares a non-default success status (201). A 200 must fail.
    const { impl } = fakeFetch([{ status: 200, body: JSON.stringify({ t: "x" }) }]);
    const config: LoginConfig = {
      login: { ...baseLogin, success_criteria: [{ condition: "$statusCode == 201" }] },
    };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("rejected");
  });

  it("classifies a 5xx that fails the criteria as `upstream_failed`, not a refusal", async () => {
    const { impl } = fakeFetch([{ status: 503, body: "maintenance" }]);
    const err = await runLogin(
      { login: baseLogin },
      {
        inputs: {},
        authorizedUris: ALLOW,
        allowAllUris: false,
        fetchImpl: impl,
        resolveHost: TEST_RESOLVE,
      },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "upstream_failed", upstreamStatus: 503 });
  });

  it("classifies a request that never reached the target as `upstream_failed`", async () => {
    const refused = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      runLogin(
        { login: baseLogin },
        {
          inputs: {},
          authorizedUris: ALLOW,
          allowAllUris: false,
          fetchImpl: refused,
          resolveHost: TEST_RESOLVE,
        },
      ),
    ).rejects.toMatchObject({ reason: "upstream_failed" });
  });

  it("rejects an oversized response body", async () => {
    const { impl } = fakeFetch([{ status: 200, body: "x".repeat(2000) }]);
    const config: LoginConfig = { login: baseLogin, limits: { max_response_bytes: 1000 } };
    await expect(
      runLogin(config, {
        inputs: {},
        authorizedUris: ALLOW,
        allowAllUris: false,
        fetchImpl: impl,
        resolveHost: TEST_RESOLVE,
      }),
    ).rejects.toMatchObject({ reason: "response_too_large" });
  });

  it("does not read an oversized body that no criterion or output reads", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: "x".repeat(2000), headers: { "X-Token": "tok" } },
    ]);
    const config: LoginConfig = {
      login: {
        request: baseLogin.request,
        success_criteria: [{ condition: "$statusCode == 200" }],
        outputs: { t: "$response.header.X-Token" },
      },
      limits: { max_response_bytes: 1000 },
    };
    const res = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    });
    expect(res.outputs.t).toBe("tok");
  });

  it("classifies an aborted (timed-out) request as `timeout`", async () => {
    // A fetchImpl that never resolves on its own but rejects the moment the
    // engine's per-request AbortController fires. With request_timeout_ms=1 the
    // setTimeout-driven abort lands almost immediately, exercising the
    // `ac.signal.aborted` branch (reason: "timeout") rather than the generic
    // request-failed branch.
    const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(signal.reason ?? new DOMException("aborted", "AbortError")),
          );
        }
      });
    }) as unknown as typeof fetch;

    const config: LoginConfig = { login: baseLogin, limits: { request_timeout_ms: 1 } };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: hangingFetch,
      resolveHost: TEST_RESOLVE,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("timeout");
  });

  it("extract_failed: a body-pointer extractor fed a non-JSON body", async () => {
    // 200 OK but the body isn't JSON — JSON.parse throws inside applyOutput,
    // which the engine maps to reason: "extract_failed".
    const { impl } = fakeFetch([{ status: 200, body: "<html>not json</html>" }]);
    const config: LoginConfig = { login: baseLogin };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("extract_failed");
    // Delete-to-fail: drop the `{ cause }` and the thrown error says only
    // "'<name>' json parse failed" — identical for an HTML login wall, an
    // empty body and truncated JSON. The body itself is never logged (it can
    // hold credentials), so the SyntaxError is the only thing left to read.
    expect((err as LoginError).cause).toBeInstanceOf(SyntaxError);
  });

  it("extract_failed: a `jwt` extractor whose token output extracted nothing", async () => {
    const { impl } = fakeFetch([{ status: 200, body: JSON.stringify({ other: "x" }) }]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token", body: "grant=pw" },
        outputs: {
          access_token: "$response.body#/access_token",
          person_id: { from: "jwt", token: "{$credential.access_token}", path: "/sub" },
        },
      },
    };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("extract_failed");
  });

  it("invalid_config before any fetch: a `jwt` token naming no declared output", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token", body: "grant=pw" },
        outputs: {
          access_token: "$response.body#/access_token",
          person_id: { from: "jwt", token: "{$credential.missing}", path: "/sub" },
        },
      },
    };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "invalid_config" });
    expect((err as LoginError).message).toContain("connect.login.outputs.person_id.token");
    expect(calls).toHaveLength(0);
  });

  it("extract_failed: a `jwt` extractor fed a garbage (undecodable) token", async () => {
    // `access_token` is extracted as a non-JWT string ("garbage", no dots) and
    // `person_id` references it as a jwt — decodeJwtPayload returns null →
    // reason: "extract_failed".
    const { impl } = fakeFetch([
      { status: 200, body: JSON.stringify({ access_token: "garbage" }) },
    ]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token", body: "grant=pw" },
        outputs: {
          access_token: "$response.body#/access_token",
          person_id: { from: "jwt", token: "{$credential.access_token}", path: "/sub" },
        },
      },
    };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("extract_failed");
  });
});

describe("runLogin — Arazzo Selector Object outputs (AFPS §7.7)", () => {
  it("jsonpointer selector extracts from $response.body", async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: JSON.stringify({ data: { token: "ABC123" } }),
      },
    ]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token" },
        outputs: {
          access_token: {
            context: "$response.body",
            selector: "/data/token",
            type: "jsonpointer",
          },
        },
      },
    };
    const res = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    });
    expect(res.outputs.access_token).toBe("ABC123");
  });

  it("jsonpath selector extracts $.data.token from $response.body", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: JSON.stringify({ data: { token: "TOK-XYZ" } }) },
    ]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token" },
        outputs: {
          access_token: {
            context: "$response.body",
            selector: "$.data.token",
            type: "jsonpath",
          },
        },
      },
    };
    const res = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    });
    expect(res.outputs.access_token).toBe("TOK-XYZ");
  });

  it("jsonpath selector with array index $.items[0].id", async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: JSON.stringify({ items: [{ id: "first" }, { id: "second" }] }),
      },
    ]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token" },
        outputs: {
          access_token: {
            context: "$response.body",
            selector: "$.items[0].id",
            type: "jsonpath",
          },
        },
      },
    };
    const res = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    });
    expect(res.outputs.access_token).toBe("first");
  });

  it("refuses an xpath selector before any fetch", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: "<root><tok>X</tok></root>" }]);
    // A manifest may declare xpath (AFPS §7.7); the engine's own types do not.
    const config = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token" },
        outputs: {
          access_token: {
            context: "$response.body",
            selector: "/root/tok/text()",
            type: "xpath",
          },
        },
      },
    } as unknown as LoginConfig;
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("invalid_config");
    expect((err as LoginError).message).toMatch(/xpath/);
    expect(calls).toHaveLength(0);
  });

  it("jsonpath with unsupported wildcard fails with invalid_config", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: JSON.stringify({ a: [1, 2] }) }]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token" },
        outputs: {
          access_token: {
            context: "$response.body",
            selector: "$.a[*]",
            type: "jsonpath",
          },
        },
      },
    };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("invalid_config");
    expect(calls).toHaveLength(0);
  });
});

describe("success_criteria engine — Arazzo Criterion types (AFPS §7.7)", () => {
  it("defaults to 2xx range when no criteria are declared", () => {
    expect(evaluateSuccessCriteriaForTest(200, new Headers(), "", [])).toBe(true);
    expect(evaluateSuccessCriteriaForTest(299, new Headers(), "", [])).toBe(true);
    expect(evaluateSuccessCriteriaForTest(300, new Headers(), "", [])).toBe(false);
    expect(evaluateSuccessCriteriaForTest(404, new Headers(), "", [])).toBe(false);
  });

  it("simple (type omitted): $statusCode == N equality", () => {
    expect(
      evaluateSuccessCriteriaForTest(201, new Headers(), "", [{ condition: "$statusCode == 201" }]),
    ).toBe(true);
    expect(
      evaluateSuccessCriteriaForTest(500, new Headers(), "", [{ condition: "$statusCode == 200" }]),
    ).toBe(false);
  });

  it("simple: $response.body#/<pointer> == <literal>", () => {
    const body = JSON.stringify({ status: "ok", count: 3 });
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: '$response.body#/status == "ok"', type: "simple" },
      ]),
    ).toBe(true);
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: "$response.body#/count == 3", type: "simple" },
      ]),
    ).toBe(true);
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: '$response.body#/status == "fail"', type: "simple" },
      ]),
    ).toBe(false);
  });

  it("simple: a single-quoted literal reads '' as one quote", () => {
    const body = JSON.stringify({ name: "O'Brien" });
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: "$response.body#/name == 'O''Brien'" },
      ]),
    ).toBe(true);
  });

  it("simple: strings compare case-insensitively (Arazzo)", () => {
    const body = JSON.stringify({ status: "OK" });
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: "$response.body#/status == 'ok'" },
      ]),
    ).toBe(true);
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: "$response.body#/status == 'ko'" },
      ]),
    ).toBe(false);
  });

  it("simple: a number equals only a string holding the same JSON number", () => {
    const headers = new Headers({ "X-N": "200", "X-Blank": " ", "X-Hex": "0x10" });
    const passes = (condition: string) =>
      evaluateSuccessCriteriaForTest(200, headers, "", [{ condition }]);
    expect(passes("$response.header.X-N == 200")).toBe(true);
    expect(passes("$response.header.X-Blank == 0")).toBe(false);
    expect(passes("$response.header.X-Hex == 16")).toBe(false);
  });

  it("simple: an absent value equals nothing, not even another absent value", () => {
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), "{}", [
        { condition: "$response.body#/a == $response.body#/b" },
      ]),
    ).toBe(false);
  });

  it("simple: a body pointer reads only canonical array indices and own members", () => {
    const passes = (body: unknown, condition: string) =>
      evaluateSuccessCriteriaForTest(200, new Headers(), JSON.stringify(body), [{ condition }]);
    expect(passes({ "1": "a", "01": "b" }, "$response.body#/01 == 'b'")).toBe(true);
    expect(passes({ a: ["x", "y"] }, "$response.body#/a/01 == 'y'")).toBe(false);
    expect(passes({ a: [1, 2, 3] }, "$response.body#/a/length == 3")).toBe(false);
    expect(passes({ a: [1, 2, 3] }, "$response.body#/a/2 == 3")).toBe(true);
  });

  it("simple: $response.header.<name> == <literal>", () => {
    const headers = new Headers({ "X-Status": "ok" });
    expect(
      evaluateSuccessCriteriaForTest(200, headers, "", [
        { condition: '$response.header.X-Status == "ok"', type: "simple" },
      ]),
    ).toBe(true);
  });

  it("jsonpath: passes when query yields a non-empty value", () => {
    const body = JSON.stringify({ session: { id: "abc" } });
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: "$.session.id", type: "jsonpath" },
      ]),
    ).toBe(true);
    // Missing path → fail.
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: "$.session.missing", type: "jsonpath" },
      ]),
    ).toBe(false);
    // Empty string → fail closed.
    const bodyEmpty = JSON.stringify({ session: { id: "" } });
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), bodyEmpty, [
        { condition: "$.session.id", type: "jsonpath" },
      ]),
    ).toBe(false);
  });

  it("regex: passes when condition matches $response.body", () => {
    const body = '{"status":"ok"}';
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: '"status"\\s*:\\s*"ok"', type: "regex" },
      ]),
    ).toBe(true);
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: '"status"\\s*:\\s*"fail"', type: "regex" },
      ]),
    ).toBe(false);
  });

  it("regex against $response.header.<name>", () => {
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
    expect(
      evaluateSuccessCriteriaForTest(200, headers, "", [
        {
          condition: "^application/json",
          type: "regex",
          context: "$response.header.Content-Type",
        },
      ]),
    ).toBe(true);
  });

  it("all criteria must pass (AND semantics)", () => {
    const body = JSON.stringify({ status: "ok" });
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: "$statusCode == 200" },
        { condition: '$response.body#/status == "ok"' },
      ]),
    ).toBe(true);
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), body, [
        { condition: "$statusCode == 200" },
        { condition: '$response.body#/status == "fail"' },
      ]),
    ).toBe(false);
  });

  it("integration: runLogin honors a jsonpath criterion against the response body", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: JSON.stringify({ token: "TOK", session: { id: "S1" } }) },
    ]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token" },
        success_criteria: [{ condition: "$.session.id", type: "jsonpath" }],
        outputs: { access_token: "$response.body#/token" },
      },
    };
    const res = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    });
    expect(res.outputs.access_token).toBe("TOK");
  });

  it("integration: runLogin fails with rejected when a regex criterion does NOT match", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: JSON.stringify({ token: "TOK", status: "fail" }) },
    ]);
    const config: LoginConfig = {
      login: {
        request: { method: "POST", url: "https://idp.example.com/token" },
        success_criteria: [{ condition: '"status"\\s*:\\s*"ok"', type: "regex" }],
        outputs: { access_token: "$response.body#/token" },
      },
    };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
      resolveHost: TEST_RESOLVE,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("rejected");
  });
});

describe("runLogin — runtime expressions (AFPS §7.7)", () => {
  const run = (
    outputs: LoginConfig["login"]["outputs"],
    response: { body?: string; headers?: Record<string, string> },
  ) =>
    runLogin(
      { login: { request: { method: "POST", url: "https://idp.example.com/token" }, outputs } },
      {
        inputs: {},
        authorizedUris: ALLOW,
        allowAllUris: false,
        fetchImpl: fakeFetch([{ status: 200, ...response }]).impl,
        resolveHost: TEST_RESOLVE,
      },
    );

  it("never reads an inherited member through a body pointer", async () => {
    await expect(run({ p: "$response.body#/__proto__" }, { body: "{}" })).rejects.toMatchObject({
      reason: "extract_failed",
    });
  });

  it("refuses an extractor that also carries selector fields", async () => {
    const sid = {
      from: "cookie",
      name: "sid",
      context: "$response.body",
      selector: "/sid",
      type: "jsonpointer",
    } as const;
    const { impl, calls } = fakeFetch([{ status: 200, headers: { "Set-Cookie": "sid=x" } }]);
    await expect(
      runLogin(
        {
          login: {
            request: { method: "POST", url: "https://idp.example.com/token" },
            outputs: { sid },
          },
        },
        {
          inputs: {},
          authorizedUris: ALLOW,
          allowAllUris: false,
          fetchImpl: impl,
          resolveHost: TEST_RESOLVE,
        },
      ),
    ).rejects.toMatchObject({ reason: "invalid_config" });
    expect(calls).toHaveLength(0);
  });

  it("regex extractor reads the body named by its source", async () => {
    const res = await run(
      { csrf: { from: "regex", source: "$response.body", pattern: "csrf=([a-z0-9]+)" } },
      { body: "<form>csrf=abc123</form>" },
    );
    expect(res.outputs.csrf).toBe("abc123");
  });

  it("regex extractor reads the header named by its source, not the body", async () => {
    const res = await run(
      { sid: { from: "regex", source: "$response.header.Location", pattern: "sid=(\\w+)" } },
      { body: "sid=from-body", headers: { Location: "https://x/?sid=fromheader" } },
    );
    expect(res.outputs.sid).toBe("fromheader");
  });

  it("regex extractor refuses a source it cannot read", async () => {
    await expect(
      run({ x: { from: "regex", source: "{$response.body}", pattern: "(.+)" } }, { body: "a" }),
    ).rejects.toMatchObject({ reason: "invalid_config" });
  });

  it("refuses an $outputs.<name> output expression", async () => {
    await expect(
      run({ t: "$response.body#/t", u: "$outputs.t" }, { body: JSON.stringify({ t: "x" }) }),
    ).rejects.toMatchObject({ reason: "invalid_config" });
  });

  it("$response.body as an output yields the body text", async () => {
    const res = await run({ raw: "$response.body" }, { body: "opaque-token" });
    expect(res.outputs.raw).toBe("opaque-token");
  });
});

describe("runLogin — input encoding (AFPS §7.7 request)", () => {
  const PASSWORD = "p&ss=w+rd %x";

  async function sent(
    request: LoginConfig["login"]["request"],
    inputs: Record<string, unknown>,
  ): Promise<{ url: string; init: RequestInit }> {
    const { impl, calls } = fakeFetch([{ status: 200, body: JSON.stringify({ t: "x" }) }]);
    await runLogin(
      { login: { request, outputs: { t: "$response.body#/t" } } },
      {
        inputs,
        authorizedUris: ALLOW,
        allowAllUris: false,
        fetchImpl: impl,
        resolveHost: TEST_RESOLVE,
      },
    );
    return calls[0]!;
  }

  const refusal = (request: LoginConfig["login"]["request"], inputs: Record<string, unknown>) => {
    const { impl, calls } = fakeFetch([{ status: 200, body: JSON.stringify({ t: "x" }) }]);
    const err = runLogin(
      { login: { request, outputs: { t: "$response.body#/t" } } },
      {
        inputs,
        authorizedUris: ALLOW,
        allowAllUris: false,
        fetchImpl: impl,
        resolveHost: TEST_RESOLVE,
      },
    ).catch((e: unknown) => e);
    return { err, calls };
  };

  it("form body: each value is one form component, never a separator", async () => {
    const { init } = await sent(
      {
        method: "POST",
        url: "https://idp.example.com/token",
        body: "grant_type=password&username={{username}}&password={{password}}",
        content_type: "application/x-www-form-urlencoded",
      },
      { username: "a b&admin=1", password: PASSWORD },
    );
    const params = new URLSearchParams(String(init.body));
    expect([...params.keys()]).toEqual(["grant_type", "username", "password"]);
    expect(params.getAll("password")).toEqual([PASSWORD]);
    expect(params.get("username")).toBe("a b&admin=1");
    // The WHATWG serializer: a space is `+`, a `+` is `%2B`.
    expect(String(init.body)).toContain("username=a+b%26admin%3D1");
  });

  it("form body: the media type is read from a Content-Type header, any case, parameters ignored", async () => {
    const { init } = await sent(
      {
        method: "POST",
        url: "https://idp.example.com/token",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "password={{password}}",
        content_type: "application/x-www-form-urlencoded",
      },
      { password: PASSWORD },
    );
    expect(new URLSearchParams(String(init.body)).getAll("password")).toEqual([PASSWORD]);
    // The declared header is the one sent: `content_type` adds no second one.
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(["content-type"]);
  });

  it("JSON body: a value is escaped inside its string literal and adds no member", async () => {
    const hostile = 'a"b\\c\n","admin":true,"x":"';
    const { init } = await sent(
      {
        method: "POST",
        url: "https://idp.example.com/token",
        body: '{"username":"{{username}}","password":"{{password}}"}',
        content_type: "application/json",
      },
      { username: hostile, password: PASSWORD },
    );
    expect(JSON.parse(String(init.body))).toEqual({ username: hostile, password: PASSWORD });
  });

  it("JSON body: a placeholder outside a string literal becomes a whole JSON string", async () => {
    const { init } = await sent(
      {
        method: "POST",
        url: "https://idp.example.com/token",
        body: '{"password":{{password}},"remember":true}',
        content_type: "application/vnd.api+json",
      },
      { password: '1,"admin":true' },
    );
    expect(JSON.parse(String(init.body))).toEqual({ password: '1,"admin":true', remember: true });
  });

  it("XML body: a value is entity-escaped, and only `]]>` is split inside CDATA", async () => {
    const hostile = "</p><admin/>&]]>";
    const { init } = await sent(
      {
        method: "POST",
        url: "https://idp.example.com/token",
        body: '<login u="{{username}}"><p>{{password}}</p><c><![CDATA[{{password}}]]></c></login>',
        content_type: "text/xml",
      },
      { username: 'x"y', password: hostile },
    );
    expect(String(init.body)).toBe(
      '<login u="x&quot;y"><p>&lt;/p&gt;&lt;admin/&gt;&amp;]]&gt;</p>' +
        "<c><![CDATA[</p><admin/>&]]]]><![CDATA[>]]></c></login>",
    );
  });

  it("a body with no known media type is sent as is", async () => {
    const { init } = await sent(
      { method: "POST", url: "https://idp.example.com/token", body: "p={{password}}" },
      { password: PASSWORD },
    );
    expect(init.body).toBe(`p=${PASSWORD}`);
  });

  it("URL: a value is one path segment or one query component", async () => {
    const { url } = await sent(
      {
        method: "GET",
        url: "https://idp.example.com/users/{{username}}/login?password={{password}}&v=1",
      },
      { username: "a/b?c#d", password: PASSWORD },
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/users/a%2Fb%3Fc%23d/login");
    expect([...parsed.searchParams.keys()]).toEqual(["password", "v"]);
    expect(parsed.searchParams.get("password")).toBe(PASSWORD);
  });

  it("URL: a leading value fills the base URL as is", async () => {
    const { url } = await sent(
      { method: "POST", url: "{{base_url}}/login?u={{username}}" },
      { base_url: "https://idp.example.com/app", username: "a&b" },
    );
    expect(url).toBe("https://idp.example.com/app/login?u=a%26b");
  });

  it("header: a value carrying CR/LF is refused before any request, naming only the field", async () => {
    const { err, calls } = refusal(
      {
        method: "POST",
        url: "https://idp.example.com/token",
        headers: { "X-Api-Key": "{{api_key}}" },
      },
      { api_key: "k\r\nX-Admin: 1" },
    );
    const e = await err;
    expect(e).toBeInstanceOf(LoginError);
    expect(e).toMatchObject({ reason: "invalid_input", field: "api_key" });
    expect((e as Error).message).not.toContain("X-Admin");
    expect(calls).toHaveLength(0);
  });

  it("header: a valid value is sent as is", async () => {
    const { init } = await sent(
      {
        method: "POST",
        url: "https://idp.example.com/token",
        headers: { Authorization: "Basic {{token}}" },
      },
      { token: "a b=c&d" },
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Basic a b=c&d");
  });

  it("refuses a value that is not well-formed Unicode", async () => {
    const { err, calls } = refusal(
      { method: "GET", url: "https://idp.example.com/token?p={{password}}" },
      { password: "a\uD800b" },
    );
    expect(await err).toMatchObject({ reason: "invalid_input", field: "password" });
    expect(calls).toHaveLength(0);
  });
  it("JSON body: a string that is a JSON scalar fills a bare position as that scalar", async () => {
    const { init } = await sent(
      {
        method: "POST",
        url: "https://idp.example.com/token",
        body: '{"pin":{{pin}},"remember":{{remember}},"name":{{name}},"pin_text":"{{pin}}"}',
        content_type: "application/json",
      },
      { pin: "1234", remember: "false", name: "1234x" },
    );
    expect(JSON.parse(String(init.body))).toEqual({
      pin: 1234,
      remember: false,
      name: "1234x",
      pin_text: "1234",
    });
  });

  it("header: a Cookie value outside cookie-octet is refused, naming the field", async () => {
    const { err, calls } = refusal(
      {
        method: "POST",
        url: "https://idp.example.com/token",
        headers: { Cookie: "sid={{sid}}" },
      },
      { sid: "x; admin=1" },
    );
    expect(await err).toMatchObject({ reason: "invalid_input", field: "sid" });
    expect(calls).toHaveLength(0);
  });

  it("JSON body: a typed value keeps its JSON type in a bare position, its text in a string", async () => {
    const { init } = await sent(
      {
        method: "POST",
        url: "https://idp.example.com/token",
        body:
          '{"pin":{{pin}},"remember":{{remember}},"profile":{{profile}},"name":{{name}},' +
          '"pin_text":"{{pin}}","profile_text":"{{profile}}","name_text":"{{name}}"}',
        content_type: "application/json",
      },
      { pin: 1234, remember: true, profile: { a: 'x"y' }, name: 'a"b' },
    );
    expect(JSON.parse(String(init.body))).toEqual({
      pin: 1234,
      remember: true,
      profile: { a: 'x"y' },
      name: 'a"b',
      pin_text: "1234",
      profile_text: '{"a":"x\\"y"}',
      name_text: 'a"b',
    });
  });

  it("multipart body: a value carrying CR or LF is refused, before any request", async () => {
    const request = {
      method: "POST" as const,
      url: "https://idp.example.com/token",
      body: '--B\r\nContent-Disposition: form-data; name="password"\r\n\r\n{{password}}\r\n--B--\r\n',
      content_type: "multipart/form-data; boundary=B",
    };
    for (const hostile of ['pw\r\n--B\r\nContent-Disposition: form-data; name="admin"', "pw\nx"]) {
      const { err, calls } = refusal(request, { password: hostile });
      expect(await err).toMatchObject({ reason: "invalid_input", field: "password" });
      expect(calls).toHaveLength(0);
    }
    const { init } = await sent(request, { password: PASSWORD });
    expect(String(init.body)).toContain(`\r\n\r\n${PASSWORD}\r\n--B--`);
  });

  it("URL: a placeholder after a literal host is a path value, never raw", async () => {
    const { err, calls } = refusal(
      { method: "POST", url: "https://idp.example.com{{path}}" },
      { path: "/login?admin=1#" },
    );
    // Encoded, the value cannot open a query: what is left is no URL this login may reach.
    expect(await err).toMatchObject({ reason: "url_not_allowed", fields: ["path"] });
    expect(calls).toHaveLength(0);
  });

  it("URL: a base URL the submitter chose outside the allowlist is refused naming that input", async () => {
    const { err, calls } = refusal(
      { method: "POST", url: "{{base_url}}/login" },
      { base_url: "https://elsewhere.example.org" },
    );
    expect(await err).toMatchObject({ reason: "url_not_allowed", fields: ["base_url"] });
    expect(calls).toHaveLength(0);
    const malformed = refusal({ method: "POST", url: "{{base_url}}/login" }, { base_url: "nope" });
    expect(await malformed.err).toMatchObject({ reason: "url_not_allowed", fields: ["base_url"] });
    const port = refusal(
      { method: "POST", url: "https://idp.example.com:{{port}}/login" },
      { port: "443@elsewhere.example.org" },
    );
    expect(await port.err).toMatchObject({ reason: "url_not_allowed", fields: ["port"] });
  });
});

describe("runLogin — what a failed answer means", () => {
  const login = (status: number, success_criteria?: { condition: string }[]) =>
    runLogin(
      {
        login: {
          request: { method: "POST", url: "https://idp.example.com/login", body: "x=1" },
          ...(success_criteria ? { success_criteria } : {}),
          outputs: { sid: { from: "cookie", name: "sid" } },
        },
      },
      {
        inputs: {},
        authorizedUris: ALLOW,
        allowAllUris: false,
        fetchImpl: fakeFetch([{ status }]).impl,
        resolveHost: TEST_RESOLVE,
      },
    ).catch((e: unknown) => e);

  for (const status of [400, 401, 403, 422]) {
    it(`${status} with no success_criteria: the credentials were refused`, async () => {
      expect(await login(status)).toMatchObject({ reason: "rejected", upstreamStatus: status });
    });
  }

  for (const status of [302, 404, 405]) {
    it(`${status} with no success_criteria: a defect of the integration, not a refusal`, async () => {
      expect(await login(status)).toMatchObject({
        reason: "unexpected_status",
        upstreamStatus: status,
      });
    });
  }

  it("an answer below 500 that fails declared success_criteria is a refusal", async () => {
    for (const status of [200, 302, 400]) {
      expect(await login(status, [{ condition: "$statusCode == 201" }])).toMatchObject({
        reason: "rejected",
        upstreamStatus: status,
      });
    }
  });

  for (const status of [404, 405, 410]) {
    it(`${status} is no login endpoint, whatever the criteria`, async () => {
      expect(await login(status, [{ condition: "$statusCode == 302" }])).toMatchObject({
        reason: "unexpected_status",
      });
    });
  }

  it("429 is the service turning the login away for now, whatever the criteria", async () => {
    expect(await login(429)).toMatchObject({ reason: "upstream_failed", upstreamStatus: 429 });
    expect(await login(429, [{ condition: "$statusCode == 302" }])).toMatchObject({
      reason: "upstream_failed",
    });
  });
});
