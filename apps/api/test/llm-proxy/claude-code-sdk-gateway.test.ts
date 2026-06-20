// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  deriveUpstreamSubpath,
  buildSubscriptionHeaders,
  subscriptionAuthErrorResponse,
} from "../../src/services/llm-proxy/claude-code-sdk-gateway.ts";
import { gone, invalidRequest, internalError } from "../../src/lib/errors.ts";

describe("deriveUpstreamSubpath", () => {
  const preset = "11111111-1111-1111-1111-111111111111";

  test("extracts the path the SDK appended after the preset segment", () => {
    expect(
      deriveUpstreamSubpath(`/api/llm-proxy/claude-code-sdk/${preset}/v1/messages`, preset),
    ).toBe("/v1/messages");
    expect(
      deriveUpstreamSubpath(
        `/api/llm-proxy/claude-code-sdk/${preset}/v1/messages/count_tokens`,
        preset,
      ),
    ).toBe("/v1/messages/count_tokens");
  });

  test("falls back to /v1/messages for the bare preset path", () => {
    expect(deriveUpstreamSubpath(`/api/llm-proxy/claude-code-sdk/${preset}`, preset)).toBe(
      "/v1/messages",
    );
  });

  test("falls back when the prefix is absent (defensive)", () => {
    expect(deriveUpstreamSubpath("/something/else", preset)).toBe("/v1/messages");
  });
});

describe("buildSubscriptionHeaders", () => {
  test("swaps in the real Bearer token, replacing the placeholder loopback bearer", () => {
    const incoming = new Headers({ authorization: "Bearer chatloop_placeholder" });
    const out = buildSubscriptionHeaders(incoming, "sk-ant-oat-REAL");
    expect(out.get("authorization")).toBe("Bearer sk-ant-oat-REAL");
  });

  test("adds the OAuth beta, merging with caller betas (de-duplicated)", () => {
    const incoming = new Headers({
      "anthropic-beta": "prompt-caching-2024-07-31, oauth-2025-04-20",
    });
    const out = buildSubscriptionHeaders(incoming, "tok");
    const betas = (out.get("anthropic-beta") ?? "").split(",").map((s) => s.trim());
    expect(betas).toContain("prompt-caching-2024-07-31");
    expect(betas.filter((b) => b === "oauth-2025-04-20")).toHaveLength(1);
  });

  test("injects the OAuth beta when the caller sent none", () => {
    const out = buildSubscriptionHeaders(new Headers(), "tok");
    expect(out.get("anthropic-beta")).toBe("oauth-2025-04-20");
  });

  test("defaults anthropic-version but preserves a caller-supplied one", () => {
    expect(buildSubscriptionHeaders(new Headers(), "tok").get("anthropic-version")).toBe(
      "2023-06-01",
    );
    const pinned = buildSubscriptionHeaders(
      new Headers({ "anthropic-version": "2099-01-01" }),
      "tok",
    );
    expect(pinned.get("anthropic-version")).toBe("2099-01-01");
  });

  test("strips x-api-key, host, content-length, accept-encoding", () => {
    const incoming = new Headers({
      "x-api-key": "leak",
      host: "127.0.0.1:3000",
      "content-length": "123",
      "accept-encoding": "gzip",
    });
    const out = buildSubscriptionHeaders(incoming, "tok");
    expect(out.get("x-api-key")).toBeNull();
    expect(out.get("host")).toBeNull();
    expect(out.get("content-length")).toBeNull();
    expect(out.get("accept-encoding")).toBeNull();
  });

  test("never leaks the real token via x-api-key", () => {
    const out = buildSubscriptionHeaders(new Headers({ "x-api-key": "old" }), "secret-token");
    const serialized = JSON.stringify([...out.entries()]);
    expect(serialized).not.toContain("x-api-key");
    expect(out.get("authorization")).toContain("secret-token");
  });
});

describe("subscriptionAuthErrorResponse", () => {
  test("translates a 410 gone() into a 401 Anthropic authentication_error envelope", async () => {
    const res = subscriptionAuthErrorResponse(
      gone("OAUTH_CONNECTION_NEEDS_RECONNECTION", "needs reconnection"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(res!.headers.get("content-type")).toBe("application/json");
    const body = (await res!.json()) as { type: string; error: { type: string; message: string } };
    // Shape the official `claude` binary recognises natively.
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
    // Actionable, user-facing (French) — not an opaque transport error.
    expect(body.error.message).toMatch(/[Rr]econnect/);
  });

  test("returns null for a non-410 ApiError (caller rethrows — not an auth problem)", () => {
    expect(subscriptionAuthErrorResponse(invalidRequest("bad"))).toBeNull();
    expect(subscriptionAuthErrorResponse(internalError())).toBeNull();
  });

  test("returns null for a plain Error (transient failures must not look like auth)", () => {
    expect(subscriptionAuthErrorResponse(new Error("ECONNRESET"))).toBeNull();
    expect(subscriptionAuthErrorResponse(undefined)).toBeNull();
  });
});
