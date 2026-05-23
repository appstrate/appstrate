// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { runLogin, LoginError, type LoginConfig } from "../../src/connect/login-engine.ts";

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

describe("runLogin — declarative login", () => {
  it("password grant: substitutes secrets, extracts token + expiry", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: JSON.stringify({ access_token: "TOK-123", expires_in: 3600 }) },
    ]);
    const config: LoginConfig = {
      steps: [
        {
          request: {
            method: "POST",
            url: "https://idp.example.com/token",
            body: "grant_type=password&username={{email}}&password={{password}}",
            contentType: "application/x-www-form-urlencoded",
          },
          extract: {
            access_token: { from: "json", path: "$.access_token" },
            expires_in: { from: "json", path: "$.expires_in" },
          },
          output: ["access_token", "expires_in"],
        },
      ],
      expiresInOutput: "expires_in",
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
      steps: [
        {
          request: { method: "POST", url: "https://idp.example.com/token", body: "p={{password}}" },
          extract: { access_token: { from: "json", path: "$.access_token" } },
          output: ["access_token"],
        },
      ],
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

  it("extracts a JWT claim (petitspas-like personId)", async () => {
    const jwt = `${b64url({ alg: "none" })}.${b64url({ AUTH: [{ personId: "P-42" }] })}.`;
    const { impl } = fakeFetch([{ status: 200, body: JSON.stringify({ access_token: jwt }) }]);
    const config: LoginConfig = {
      steps: [
        {
          request: { method: "POST", url: "https://idp.example.com/token", body: "grant=pw" },
          extract: {
            access_token: { from: "json", path: "$.access_token" },
            person_id: { from: "jwt", token: "access_token", path: "$.AUTH[0].personId" },
          },
          output: ["access_token", "person_id"],
        },
      ],
      identityOutputs: ["person_id"],
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
      steps: [
        {
          request: { method: "POST", url: "https://idp.example.com/token", body: "grant=pw" },
          // `person_id` (jwt) is declared BEFORE `access_token` it depends on —
          // mimics a manifest reordered by JSONB persistence. The engine's
          // two-pass extraction (non-jwt first) must still resolve it.
          extract: {
            person_id: { from: "jwt", token: "access_token", path: "$.AUTH[0].personId" },
            access_token: { from: "json", path: "$.access_token" },
          },
          output: ["access_token", "person_id"],
        },
      ],
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
    // "" rather than throwing, so without the empty-guard the engine would
    // silently persist `JSESSIONID=""`. Assert it fails closed instead.
    const { impl } = fakeFetch([{ status: 200, body: "ok" }]);
    const config: LoginConfig = {
      steps: [
        {
          request: { method: "POST", url: "https://idp.example.com/login", body: "u=x" },
          extract: { JSESSIONID: { from: "cookie", name: "JSESSIONID" } },
          output: ["JSESSIONID"],
        },
      ],
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
      steps: [
        {
          request: { method: "POST", url: "https://idp.example.com/login", body: "u=x" },
          extract: { JSESSIONID: { from: "cookie", name: "JSESSIONID" } },
          output: ["JSESSIONID"],
        },
      ],
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
  const baseStep = {
    request: { method: "POST" as const, url: "https://idp.example.com/token", body: "x=1" },
    extract: { t: { from: "json" as const, path: "$.t" } },
    output: ["t"],
  };

  it("rejects a URL outside the authorizedUris allowlist", async () => {
    const { impl } = fakeFetch([{ status: 200, body: "{}" }]);
    const config: LoginConfig = {
      steps: [{ ...baseStep, request: { ...baseStep.request, url: "https://evil.example.com/x" } }],
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
      steps: [{ ...baseStep, request: { ...baseStep.request, body: "x={{missing}}" } }],
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
    const config: LoginConfig = { steps: [baseStep] };
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

  it("rejects an oversized response body", async () => {
    const { impl } = fakeFetch([{ status: 200, body: "x".repeat(2000) }]);
    const config: LoginConfig = { steps: [baseStep], limits: { maxResponseBytes: 1000 } };
    await expect(
      runLogin(config, {
        inputs: {},
        authorizedUris: ALLOW,
        allowAllUris: false,
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ reason: "response_too_large" });
  });
});
