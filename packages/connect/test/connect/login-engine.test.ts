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

const ALLOW = ["https://idp.example.com/**"];

describe("runLogin — declarative login (AFPS 2.0)", () => {
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
      now: () => 1_000_000,
    });

    expect(res.outputs.access_token).toBe("TOK-123");
    // expiresAt computed from expires_in seconds.
    expect(res.expiresAt).toBe(new Date(1_000_000 + 3600 * 1000).toISOString());
    // The login request received the substituted secret in the body.
    expect(calls[0]!.init.body).toBe("grant_type=password&username=a@b.co&password=s3cr3t");
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
    });
    await expect(run).rejects.toMatchObject({ reason: "url_not_allowed" });
    // Fail-closed: the request never went out.
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
      }),
    ).rejects.toMatchObject({ reason: "unresolved_placeholder" });
  });

  it("rejects a non-OK status without echoing the body", async () => {
    const { impl } = fakeFetch([{ status: 401, body: "secret-error-detail" }]);
    const config: LoginConfig = { login: baseLogin };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("bad_status");
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
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("bad_status");
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
      }),
    ).rejects.toMatchObject({ reason: "response_too_large" });
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
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("extract_failed");
  });

  it("extract_failed: a `jwt` extractor whose token ref is absent from scope", async () => {
    // The `jwt` extractor names `token: {$credential.missing}`, but no other
    // extractor produced a `missing` value — `scope[field]` is undefined → fail
    // closed.
    const { impl } = fakeFetch([{ status: 200, body: JSON.stringify({ access_token: "TOK" }) }]);
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
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("extract_failed");
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
    });
    expect(res.outputs.access_token).toBe("first");
  });

  it("xpath selector raises a structured 'not supported' LoginError", async () => {
    const { impl } = fakeFetch([{ status: 200, body: "<root><tok>X</tok></root>" }]);
    const config: LoginConfig = {
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
    };
    const err = await runLogin(config, {
      inputs: {},
      authorizedUris: ALLOW,
      allowAllUris: false,
      fetchImpl: impl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("invalid_config");
    expect((err as LoginError).message).toMatch(/xpath/);
  });

  it("jsonpath with unsupported wildcard fails with invalid_config", async () => {
    const { impl } = fakeFetch([{ status: 200, body: JSON.stringify({ a: [1, 2] }) }]);
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
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("invalid_config");
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

  it("xpath: conservatively fails (no XML evaluator)", () => {
    expect(
      evaluateSuccessCriteriaForTest(200, new Headers(), "<root/>", [
        { condition: "//root", type: "xpath" },
      ]),
    ).toBe(false);
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
    });
    expect(res.outputs.access_token).toBe("TOK");
  });

  it("integration: runLogin fails with bad_status when a regex criterion does NOT match", async () => {
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
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).reason).toBe("bad_status");
  });
});
