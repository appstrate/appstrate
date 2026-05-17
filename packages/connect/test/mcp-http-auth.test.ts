// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  AuthLoopExceededError,
  StepUpFailedError,
  buildAuthorizationUrl,
  executeWithBearer,
  parseWwwAuthenticateChallenge,
} from "../src/mcp-http-auth.ts";

describe("parseWwwAuthenticateChallenge", () => {
  it("returns null for missing/empty headers", () => {
    expect(parseWwwAuthenticateChallenge(null)).toBeNull();
    expect(parseWwwAuthenticateChallenge(undefined)).toBeNull();
    expect(parseWwwAuthenticateChallenge("")).toBeNull();
    expect(parseWwwAuthenticateChallenge("   ")).toBeNull();
  });

  it("returns null for non-Bearer schemes", () => {
    expect(parseWwwAuthenticateChallenge('Basic realm="x"')).toBeNull();
    expect(parseWwwAuthenticateChallenge('Digest qop="auth"')).toBeNull();
  });

  it("parses realm + error + resource_metadata + scope", () => {
    const header =
      'Bearer realm="MCP", error="insufficient_scope", error_description="need more", resource_metadata="https://api.example/.well-known/oauth-protected-resource", scope="read:agents write:agents"';
    const challenge = parseWwwAuthenticateChallenge(header);
    expect(challenge).toEqual({
      scheme: "Bearer",
      realm: "MCP",
      error: "insufficient_scope",
      error_description: "need more",
      resource_metadata: "https://api.example/.well-known/oauth-protected-resource",
      scope: "read:agents write:agents",
      params: {
        realm: "MCP",
        error: "insufficient_scope",
        error_description: "need more",
        resource_metadata: "https://api.example/.well-known/oauth-protected-resource",
        scope: "read:agents write:agents",
      },
    });
  });

  it("tolerates unquoted values and mixed whitespace", () => {
    const challenge = parseWwwAuthenticateChallenge("Bearer realm=foo, error=invalid_token");
    expect(challenge?.realm).toBe("foo");
    expect(challenge?.error).toBe("invalid_token");
  });
});

describe("executeWithBearer — 200 path", () => {
  it("attaches the bearer header and returns the response", async () => {
    const calls: Array<Record<string, string>> = [];
    const r = await executeWithBearer(
      async ({ headers }) => {
        calls.push(headers);
        return new Response("ok", { status: 200 });
      },
      { initial: { accessToken: "tok-1" } },
    );
    expect(r.attemptCount).toBe(1);
    expect(calls[0]!.Authorization).toBe("Bearer tok-1");
    expect(r.response.status).toBe(200);
  });
});

describe("executeWithBearer — step-up flow", () => {
  it("re-acquires a token on 401 insufficient_scope and retries once", async () => {
    let call = 0;
    const r = await executeWithBearer(
      async ({ headers }) => {
        call += 1;
        if (call === 1) {
          expect(headers.Authorization).toBe("Bearer narrow");
          return new Response("", {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="agents:write"',
            },
          });
        }
        expect(headers.Authorization).toBe("Bearer wide");
        return new Response("ok", { status: 200 });
      },
      {
        initial: { accessToken: "narrow" },
        acquireToken: async ({ scopes }) => {
          expect(scopes).toEqual(["agents:write"]);
          return { accessToken: "wide", scopes: ["agents:write"] };
        },
      },
    );
    expect(r.attemptCount).toBe(2);
    expect(r.response.status).toBe(200);
    expect(r.bearerUsed.accessToken).toBe("wide");
  });

  it("plain 401 without scope hint is returned to the caller — no loop", async () => {
    const r = await executeWithBearer(
      async () =>
        new Response("", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
        }),
      {
        initial: { accessToken: "t" },
        acquireToken: async () => {
          throw new Error("should not be called");
        },
      },
    );
    expect(r.attemptCount).toBe(1);
    expect(r.response.status).toBe(401);
  });

  it("AuthLoopExceededError when the retry also returns 401 with scope step-up", async () => {
    let caught: unknown;
    try {
      await executeWithBearer(
        async () =>
          new Response("", {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="more"',
            },
          }),
        {
          initial: { accessToken: "t" },
          acquireToken: async () => ({ accessToken: "t2" }),
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthLoopExceededError);
  });

  it("StepUpFailedError when acquireToken throws", async () => {
    let caught: unknown;
    try {
      await executeWithBearer(
        async () =>
          new Response("", {
            status: 401,
            headers: { "WWW-Authenticate": 'Bearer scope="x"' },
          }),
        {
          initial: { accessToken: "t" },
          acquireToken: async () => {
            throw new Error("refresh blew up");
          },
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StepUpFailedError);
    expect((caught as StepUpFailedError).underlying).toBeInstanceOf(Error);
  });
});

describe("buildAuthorizationUrl", () => {
  it("includes mandatory MCP params: response_type=code, S256, resource=", () => {
    const u = buildAuthorizationUrl({
      authorizationEndpoint: "https://as.example/authorize",
      clientId: "cli-1",
      redirectUri: "https://app.example/cb",
      resource: "https://api.example/mcp",
      scopes: ["read", "write"],
      codeChallenge: "abc123",
      state: "st-1",
    });
    const parsed = new URL(u);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("cli-1");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example/cb");
    expect(parsed.searchParams.get("resource")).toBe("https://api.example/mcp");
    expect(parsed.searchParams.get("scope")).toBe("read write");
    expect(parsed.searchParams.get("code_challenge")).toBe("abc123");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("st-1");
  });

  it("omits scope when scopes is empty", () => {
    const u = buildAuthorizationUrl({
      authorizationEndpoint: "https://as.example/authorize",
      clientId: "x",
      redirectUri: "https://x/cb",
      resource: "https://r",
      codeChallenge: "c",
      state: "s",
    });
    expect(new URL(u).searchParams.has("scope")).toBe(false);
  });

  it("preserves an existing query string on the authorize endpoint", () => {
    const u = buildAuthorizationUrl({
      authorizationEndpoint: "https://as.example/authorize?audience=preset",
      clientId: "x",
      redirectUri: "https://x/cb",
      resource: "https://r",
      codeChallenge: "c",
      state: "s",
    });
    const parsed = new URL(u);
    expect(parsed.searchParams.get("audience")).toBe("preset");
    expect(parsed.searchParams.get("resource")).toBe("https://r");
  });
});
